import { z } from 'zod';
import { WareBusinessResponseSchema, NormalizedProductSchema } from './schema';
import { TaobaoItemDetailSchema } from './taobao-schema';
import { WareBusinessResponse, NormalizedProduct } from '../types';
import { TaobaoItemDetail } from '../types/taobao';
import { logger } from '../logging';

export class ResponseValidator {
  validateWareBusiness(data: unknown): { valid: boolean; data?: WareBusinessResponse; errors?: string[] } {
    try {
      const parsed = WareBusinessResponseSchema.parse(data);
      return { valid: true, data: parsed as WareBusinessResponse };
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors = err.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        logger.warn({ errors }, 'WAREBUSINESS validation failed');
        return { valid: false, errors };
      }
      return { valid: false, errors: [(err as Error).message] };
    }
  }

  validateNormalized(data: unknown): { valid: boolean; data?: NormalizedProduct; errors?: string[] } {
    try {
      const parsed = NormalizedProductSchema.parse(data);
      return { valid: true, data: parsed as NormalizedProduct };
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors = err.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        return { valid: false, errors };
      }
      return { valid: false, errors: [(err as Error).message] };
    }
  }

  validateTaobaoItemDetail(data: unknown): { valid: boolean; data?: TaobaoItemDetail; errors?: string[] } {
    try {
      const parsed = TaobaoItemDetailSchema.parse(data);
      return { valid: true, data: parsed as TaobaoItemDetail };
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors = err.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        logger.warn({ errors }, 'Taobao item detail validation failed');
        return { valid: false, errors };
      }
      return { valid: false, errors: [(err as Error).message] };
    }
  }
}
