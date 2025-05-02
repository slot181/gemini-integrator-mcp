import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const generateVideoSchema: z.ZodObject<{
    prompt: z.ZodString;
    aspectRatio: z.ZodDefault<z.ZodOptional<z.ZodEnum<["16:9", "9:16", "1:1"]>>>;
    personGeneration: z.ZodDefault<z.ZodOptional<z.ZodEnum<["dont_allow", "allow_adult"]>>>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspectRatio: "1:1" | "9:16" | "16:9";
    personGeneration: "dont_allow" | "allow_adult";
}, {
    prompt: string;
    aspectRatio?: "1:1" | "9:16" | "16:9" | undefined;
    personGeneration?: "dont_allow" | "allow_adult" | undefined;
}>;
type GenerateVideoParams = z.infer<typeof generateVideoSchema>;
/**
 * Handles the video generation tool request.
 * Initiates async generation, polls for completion, saves the video locally,
 * uploads to CF ImgBed if configured, and returns the results.
 */
export declare function handleGenerateVideo(params: GenerateVideoParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
