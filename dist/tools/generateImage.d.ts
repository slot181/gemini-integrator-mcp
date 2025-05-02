import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const generateImageSchema: z.ZodObject<{
    prompt: z.ZodString;
    aspectRatio: z.ZodDefault<z.ZodOptional<z.ZodEnum<["1:1", "3:4", "4:3", "9:16", "16:9"]>>>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
}, {
    prompt: string;
    aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
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
