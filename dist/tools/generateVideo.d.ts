import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const generateVideoSchema: z.ZodObject<{
    prompt: z.ZodString;
    aspectRatio: z.ZodDefault<z.ZodOptional<z.ZodEnum<["16:9", "9:16", "1:1"]>>>;
    personGeneration: z.ZodDefault<z.ZodOptional<z.ZodEnum<["allow", "dont_allow"]>>>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspectRatio: "16:9" | "9:16" | "1:1";
    personGeneration: "allow" | "dont_allow";
}, {
    prompt: string;
    aspectRatio?: "16:9" | "9:16" | "1:1" | undefined;
    personGeneration?: "allow" | "dont_allow" | undefined;
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
