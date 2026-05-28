import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import AftermarketProduct from '../models/AftermarketProduct.model';
import AftermarketOrder from '../models/AftermarketOrder.model';
import storageService, { BucketType } from '../services/storage.service';
import { getSocketIO } from '../utils/socketEmitter';

// ─── Helpers ───────────────────────────────────────────────────────────────

type MulterFiles = { [field: string]: Express.Multer.File[] } | undefined;

/** Broadcast a product change to everyone in the organization room. */
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
    // Socket emission is non-critical — never fail the request because of it.
    console.error('[Aftermarket] Failed to emit socket event:', error);
  }
}

/** Push an uploaded media file to R2 and return an attachment subdocument. */
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

/** Push an uploaded document attachment to R2. */
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

/**
 * Create a product
 * POST /api/crm/aftermarket   (CRM admin only, multipart/form-data)
 */
const createProduct = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can create Finance Line products');
  }
  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization.');
  }

  const { name, price, description } = req.body;

  if (!name?.trim() || !description?.trim() || price === undefined || price === '') {
    throw new ApiError(400, 'name, price, and description are required');
  }

  const priceNum = Number(price);
  if (Number.isNaN(priceNum) || priceNum < 0) {
    throw new ApiError(400, 'price must be a non-negative number');
  }

  // 🔎 DEBUG: org this product is being stamped with
  console.log('[Aftermarket][CREATE] stamping organizationId =', actor.organizationId.toString());

  const files = req.files as MulterFiles;
  const [fileAttachment, mediaAttachment] = await Promise.all([
    uploadFile(files?.file?.[0]),
    uploadMedia(files?.media?.[0]),
  ]);

  const product = await AftermarketProduct.create({
    organizationId: actor.organizationId,
    name: name.trim(),
    price: priceNum,
    description: description.trim(),
    file: fileAttachment,
    media: mediaAttachment,
    isActive: true,
    createdBy: actor._id,
  });

  emitProductEvent(actor.organizationId.toString(), 'aftermarket:product_created', product);

  res.status(201).json(new ApiResponse(201, product, 'Product created successfully'));
});

/**
 * Update a product
 * PATCH /api/crm/aftermarket/:id   (CRM admin only, multipart/form-data)
 */
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

  if (price !== undefined && price !== '') {
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

  // Replace or remove the document attachment
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

  // Replace or remove the media attachment
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

/**
 * Delete a product
 * DELETE /api/crm/aftermarket/:id   (CRM admin only)
 */
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

  // Best-effort cleanup of R2 assets
  if (product.file?.url) {
    await storageService.delete(product.file.url, BucketType.PUBLIC).catch(() => {});
  }
  if (product.media?.url) {
    await storageService.delete(product.media.url, BucketType.PUBLIC).catch(() => {});
  }

  emitProductEvent(actor.organizationId.toString(), 'aftermarket:product_deleted', { _id: id });

  res.json(new ApiResponse(200, { _id: id }, 'Product deleted successfully'));
});

/**
 * List products for the CRM management table (includes inactive)
 * GET /api/crm/aftermarket
 */
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

/**
 * List active products for the customer Aftermarket browse view
 * GET /api/aftermarket  (authenticated customer)
 */
const getProductsForCustomer = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
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

  // 🔎 DEBUG: org the customer is querying with + how many matched
  console.log(
    '[Aftermarket][CUSTOMER] querying organizationId =', orgId,
    '| matched =', products.length,
    '| total active in collection =', await AftermarketProduct.countDocuments({ isActive: true })
  );

  res.json(new ApiResponse(200, products, 'Aftermarket products fetched'));
});

/**
 * Get a single active product
 * GET /api/aftermarket/:id  (authenticated customer)
 */
const getProductById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'No organization context for this account.');

  const product = await AftermarketProduct.findOne({
    _id: req.params.id,
    organizationId: orgId,
    isActive: true,
  }).select('name price description file media createdAt');

  if (!product) throw new ApiError(404, 'Product not found');

  res.json(new ApiResponse(200, product, 'Product fetched'));
});

/**
 * Place an order (cart checkout)
 * POST /api/aftermarket/checkout  (authenticated customer)
 */
const checkout = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const customerId = (req.user as { _id: mongoose.Types.ObjectId })?._id;

  if (!customerId) throw new ApiError(401, 'Not authenticated');
  if (!orgId) throw new ApiError(403, 'No organization context for this account.');

  const { items } = req.body as { items?: Array<{ productId: string; quantity: number }> };

  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'Cart is empty');
  }

  // Re-fetch products server-side so we never trust client-supplied prices.
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
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    return {
      productId: product._id,
      name: product.name,
      price: product.price,
      quantity,
    };
  });

  const subtotal = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const total = subtotal; // add tax/fees here if needed

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

/**
 * List the current customer's orders
 * GET /api/aftermarket/orders/mine  (authenticated customer)
 */
const getMyOrders = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const customerId = (req.user as { _id: mongoose.Types.ObjectId })?._id;
  if (!customerId) throw new ApiError(401, 'Not authenticated');

  const orders = await AftermarketOrder.find({ customerId, organizationId: orgId }).sort({
    createdAt: -1,
  });

  res.json(new ApiResponse(200, orders, 'Orders fetched'));
});

export default {
  // admin
  createProduct,
  updateProduct,
  deleteProduct,
  getProductsForCrm,
  // customer
  getProductsForCustomer,
  getProductById,
  checkout,
  getMyOrders,
};