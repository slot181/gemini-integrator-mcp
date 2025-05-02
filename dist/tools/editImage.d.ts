import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const editImageSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    image_url: z.ZodOptional<z.ZodString>;
    image_path: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    image_url?: string | undefined;
    image_path?: string | undefined;
}, {
    prompt: string;
    image_url?: string | undefined;
    image_path?: string | undefined;
}>, {
    prompt: string;
    image_url?: string | undefined;
    image_path?: string | undefined;
}, {
    prompt: string;
    image_url?: string | undefined;
    image_path?: string | undefined;
}>;
export declare const editImageShape: {
    prompt: z.ZodString;
    image_url: z.ZodOptional<z.ZodString>;
    image_path: z.ZodOptional<z.ZodString>;
};
type EditImageParams = z.infer<typeof editImageSchema>;
/**
 * Handles the image editing tool request.
 */
export declare function handleEditImage(params: EditImageParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
