import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const uploadLargeMediaShape: {
    url: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
};
export declare const uploadLargeMediaSchema: z.ZodEffects<z.ZodObject<{
    url: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    path?: string | undefined;
    url?: string | undefined;
}, {
    path?: string | undefined;
    url?: string | undefined;
}>, {
    path?: string | undefined;
    url?: string | undefined;
}, {
    path?: string | undefined;
    url?: string | undefined;
}>;
type UploadLargeMediaParams = z.infer<typeof uploadLargeMediaSchema>;
/**
 * Handles the large media upload tool request.
 * Returns an immediate success message and performs upload/polling in the background.
 */
export declare function handleUploadLargeMedia(params: UploadLargeMediaParams): Promise<{
    content: Array<TextContent>;
}>;
export {};
