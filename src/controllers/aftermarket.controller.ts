import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import AftermarketProduct from '../models/AftermarketProduct.model';
import AftermarketOrder from '../models/AftermarketOrder.model';
import Organization from '../models/Organization.model';
import storageService, { BucketType } from '../services/storage.service';
import { getSocketIO } from '../utils/socketEmitter';

// ─── Helpers ───────────────────────────────────────────────────────────────

type MulterFiles = { [field: string]: Express.Multer.File[] } | undefined;

/**
 * Resolve the organization a customer request should be scoped to.
 * Prefers the org on the user (req.orgId). If the customer has no org AND
 * the deployment has exactly one dealership, fall back to that single org
 * so a misconfigured/legacy customer account can still browse. Returns
 * undefined only for genuine multi-dealership ambiguity.
 */
async function resolveCustomerOrg(req: Request): Promise<string | undefined> {
  if (req.orgId) return req.orgId;

  const orgCount = await Organization.countDocuments({});
  if (orgCount === 1) {
    const only = await Organization.findOne().select('_id');
    if (only) return only._id.toString();
  }
  return undefined;
}

function emitProductEvent(
  organizationId: string,
  event: 'aftermarket:product_created' | 'aftermarket:product_updated' | 'aftermarket:product_deleted',
  payload: unknown
) {
  try {
    const io = getSocketIO();
    if (io) {
      io.to(`org:${organizationId}`).emit(event, payload);
    }
  } catch (error) {
    console.error('[Aftermarket] Failed to emit socket event:', error);
  }
}

async function uploadMedia(file?: Express.Multer.File) {
  if (!file) return undefined;
  const url = await storageService.upload(file, 'aftermarket/media', BucketType.PUBLIC);
  return {
    url,
    key: storageService.getKeyFromUrl(url) || undefined,
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    mediaType: file.mimetype.startsWith('video/') ? ('video' as const) : ('image' as const),
  };
}

async function uploadFile(file?: Express.Multer.File) {
  if (!file) return undefined;
  const url = await storageService.upload(file, 'aftermarket/files', BucketType.PUBLIC);
  return {
    url,
    key: storageService.getKeyFromUrl(url) || undefined,
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

// ─── Admin (CRM) endpoints ───────────────────────────────────────────────────

const createProduct = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can create Finance Line products');
  }
  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization.');
  }

  const { name, price, description } = req.body;

  if (!name?.trim() || !description?.trim()) {
    throw new ApiError(400, 'name and description are required');
  }

  let priceNum: number | undefined;
  if (price !== undefined && price !== '') {
    priceNum = Number(price);
    if (Number.isNaN(priceNum) || priceNum < 0) {
      throw new ApiError(400, 'price must be a non-negative number');
    }
  }

  console.log('[Aftermarket][CREATE] stamping organizationId =', actor.organizationId.toString());

  const files = req.files as MulterFiles;
  const [fileAttachment, mediaAttachment] = await Promise.all([
    uploadFile(files?.file?.[0]),
    uploadMedia(files?.media?.[0]),
  ]);

  const product = await AftermarketProduct.create({
    organizationId: actor.organizationId,
    name: name.trim(),
    ...(priceNum !== undefined && { price: priceNum }),
    description: description.trim(),
    file: fileAttachment,
    media: mediaAttachment,
    isActive: true,
    createdBy: actor._id,
  });

  emitProductEvent(actor.organizationId.toString(), 'aftermarket:product_created', product);

  res.status(201).json(new ApiResponse(201, product, 'Product created successfully'));
});

const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can edit Finance Line products');
  }
  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization.');
  }

  const { id } = req.params;
  const product = await AftermarketProduct.findOne({
    _id: id,
    organizationId: actor.organizationId,
  });
  if (!product) throw new ApiError(404, 'Product not found');

  const { name, price, description, isActive, removeFile, removeMedia } = req.body;

  if (name?.trim()) product.name = name.trim();
  if (description?.trim()) product.description = description.trim();

  if (price === '' || price === null) {
    product.price = undefined;
  } else if (price !== undefined) {
    const priceNum = Number(price);
    if (Number.isNaN(priceNum) || priceNum < 0) {
      throw new ApiError(400, 'price must be a non-negative number');
    }
    product.price = priceNum;
  }

  if (isActive !== undefined) {
    product.isActive = isActive === 'true' || isActive === true;
  }

  const files = req.files as MulterFiles;

  if (files?.file?.[0]) {
    if (product.file?.url) {
      await storageService.delete(product.file.url, BucketType.PUBLIC).catch(() => {});
    }
    product.file = await uploadFile(files.file[0]);
  } else if (removeFile === 'true' || removeFile === true) {
    if (product.file?.url) {
      await storageService.delete(product.file.url, BucketType.PUBLIC).catch(() => {});
    }
    product.file = undefined;
  }

  if (files?.media?.[0]) {
    if (product.media?.url) {
      await storageService.delete(product.media.url, BucketType.PUBLIC).catch(() => {});
    }
    product.media = await uploadMedia(files.media[0]);
  } else if (removeMedia === 'true' || removeMedia === true) {
    if (product.media?.url) {
      await storageService.delete(product.media.url, BucketType.PUBLIC).catch(() => {});
    }
    product.media = undefined;
  }

  await product.save();

  emitProductEvent(actor.organizationId.toString(), 'aftermarket:product_updated', product);

  res.json(new ApiResponse(200, product, 'Product updated successfully'));
});

const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can delete Finance Line products');
  }
  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization.');
  }

  const { id } = req.params;
  const product = await AftermarketProduct.findOneAndDelete({
    _id: id,
    organizationId: actor.organizationId,
  });
  if (!product) throw new ApiError(404, 'Product not found');

  if (product.file?.url) {
    await storageService.delete(product.file.url, BucketType.PUBLIC).catch(() => {});
  }
  if (product.media?.url) {
    await storageService.delete(product.media.url, BucketType.PUBLIC).catch(() => {});
  }

  emitProductEvent(actor.organizationId.toString(), 'aftermarket:product_deleted', { _id: id });

  res.json(new ApiResponse(200, { _id: id }, 'Product deleted successfully'));
});

const getProductsForCrm = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization.');
  }

  const { page = '1', limit = '20', search } = req.query;
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const filter: Record<string, unknown> = { organizationId: actor.organizationId };

  const searchValue = typeof search === 'string' ? search.trim() : '';
  if (searchValue) {
    const escaped = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      { description: { $regex: escaped, $options: 'i' } },
    ];
  }

  const [products, total] = await Promise.all([
    AftermarketProduct.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
    AftermarketProduct.countDocuments(filter),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        products,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
      },
      'Products fetched successfully'
    )
  );
});

// ─── Customer (Portal) endpoints ──────────────────────────────────────────────

const getProductsForCustomer = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await resolveCustomerOrg(req);

  console.log(
    '[Aftermarket][CUSTOMER] req.orgId =', req.orgId,
    '| resolved =', orgId,
    '| user =', (req.user as any)?._id?.toString(), (req.user as any)?.email
  );

  if (!orgId) {
    throw new ApiError(403, 'No organization context for this account.');
  }

  const { search } = req.query;
  const filter: Record<string, unknown> = {
    organizationId: orgId,
    isActive: true,
  };

  const searchValue = typeof search === 'string' ? search.trim() : '';
  if (searchValue) {
    const escaped = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      { description: { $regex: escaped, $options: 'i' } },
    ];
  }

  const products = await AftermarketProduct.find(filter)
    .select('name price description file media createdAt')
    .sort({ createdAt: -1 });

  console.log('[Aftermarket][CUSTOMER] matched =', products.length);

  res.json(new ApiResponse(200, products, 'Aftermarket products fetched'));
});

const getProductById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await resolveCustomerOrg(req);
  if (!orgId) throw new ApiError(403, 'No organization context for this account.');

  const product = await AftermarketProduct.findOne({
    _id: req.params.id,
    organizationId: orgId,
    isActive: true,
  }).select('name price description file media createdAt');

  if (!product) throw new ApiError(404, 'Product not found');

  res.json(new ApiResponse(200, product, 'Product fetched'));
});

const checkout = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await resolveCustomerOrg(req);
  const customerId = (req.user as { _id: mongoose.Types.ObjectId })?._id;

  if (!customerId) throw new ApiError(401, 'Not authenticated');
  if (!orgId) throw new ApiError(403, 'No organization context for this account.');

  const { items } = req.body as { items?: Array<{ productId: string; quantity: number }> };

  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'Cart is empty');
  }

  const productIds = items.map((i) => i.productId);
  const products = await AftermarketProduct.find({
    _id: { $in: productIds },
    organizationId: orgId,
    isActive: true,
  });

  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  const orderItems = items.map((item) => {
    const product = productMap.get(item.productId);
    if (!product) {
      throw new ApiError(400, `Product ${item.productId} is unavailable`);
    }
    if (product.price == null) {
      throw new ApiError(400, `Product "${product.name}" has no price. Please contact us for pricing.`);
    }
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    return {
      productId: product._id,
      name: product.name,
      price: product.price,
      quantity,
    };
  });

  const subtotal = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const total = subtotal;

  const order = await AftermarketOrder.create({
    organizationId: orgId,
    customerId,
    items: orderItems,
    subtotal,
    total,
    status: 'pending',
  });

  res.status(201).json(
    new ApiResponse(201, order, 'Order placed successfully. Awaiting payment processing.')
  );
});

const getMyOrders = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await resolveCustomerOrg(req);
  const customerId = (req.user as { _id: mongoose.Types.ObjectId })?._id;
  if (!customerId) throw new ApiError(401, 'Not authenticated');

  const filter: Record<string, unknown> = { customerId };
  if (orgId) filter.organizationId = orgId;

  const orders = await AftermarketOrder.find(filter).sort({ createdAt: -1 });

  res.json(new ApiResponse(200, orders, 'Orders fetched'));
});

export default {
  createProduct,
  updateProduct,
  deleteProduct,
  getProductsForCrm,
  getProductsForCustomer,
  getProductById,
  checkout,
  getMyOrders,
};