import jwt, { Secret } from 'jsonwebtoken';
import config from '../config';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';
import crypto from 'crypto';

export interface TokenPayload {
    sub: string;
    email: string;
    role: string;
    orgId?: string;
    iat?: number;
    exp?: number;
}

class TokenService {
    private readonly accessSecret: Secret;
    private readonly refreshSecret: Secret;
    private readonly accessExpires: string;
    private readonly refreshExpires: string;

    constructor() {
        // Map to existing config properties
        this.accessSecret = (config.jwt.accessSecret as Secret) || 'access-secret-change-me';
        this.refreshSecret = (config.jwt.refreshSecret as Secret) || 'refresh-secret-change-me';
        this.accessExpires = config.jwt.accessExpiration || '15m';
        this.refreshExpires = config.jwt.refreshExpiration || '7d';
    }

    /**
     * Generate Access Token (Short-lived)
     */
    generateAccessToken(user: { _id: mongoose.Types.ObjectId; email: string; role: string; organizationId?: mongoose.Types.ObjectId }): string {
        const payload: TokenPayload = {
            sub: user._id.toString(),
            email: user.email,
            role: user.role,
            orgId: user.organizationId?.toString(),
        };

        return jwt.sign(payload, this.accessSecret, { expiresIn: this.accessExpires as any });
    }

    /**
     * Generate Refresh Token (Long-lived)
     */
    generateRefreshToken(user: { _id: mongoose.Types.ObjectId }): string {
        const payload = {
            sub: user._id.toString(),
            type: 'refresh',
            jti: crypto.randomBytes(16).toString('hex'), // Unique ID for each token
        };

        return jwt.sign(payload, this.refreshSecret, { expiresIn: this.refreshExpires as any });
    }

    /**
     * Verify Access Token
     */
    verifyAccessToken(token: string): TokenPayload {
        try {
            return jwt.verify(token, this.accessSecret) as TokenPayload;
        } catch (error: any) {
            console.error('[TokenService] Access Token Verification Failed:', {
                name: error.name,
                message: error.message,
                expiredAt: error.expiredAt
            });
            throw new ApiError(401, 'Invalid or expired access token');
        }
    }

    /**
     * Verify Refresh Token
     */
    verifyRefreshToken(token: string): any {
        try {
            return jwt.verify(token, this.refreshSecret);
        } catch (error) {
            throw new ApiError(401, 'Invalid or expired refresh token');
        }
    }
}

export default new TokenService();
