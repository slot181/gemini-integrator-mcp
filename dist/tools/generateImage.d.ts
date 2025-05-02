import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const generateImageSchema: z.ZodObject<{
    prompt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    prompt: string;
}, {
    prompt: string;
}>;
type GenerateImageParams = z.infer<typeof generateImageSchema>;
/**
 * Handles the image generation tool request.
 * Calls the Gemini API, saves the image locally, uploads to CF ImgBed if configured,
 * and returns the results.
 */
export declare function handleGenerateImage(params: GenerateImageParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
