import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const generateVideoSchema: z.ZodObject<{
    prompt: z.ZodString;
    negativePrompt: z.ZodOptional<z.ZodString>;
    aspectRatio: z.ZodDefault<z.ZodOptional<z.ZodEnum<["16:9", "9:16", "1:1"]>>>;
    personGeneration: z.ZodDefault<z.ZodOptional<z.ZodEnum<["dont_allow", "allow_adult"]>>>;
    numberOfVideos: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    durationSeconds: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspectRatio: "1:1" | "9:16" | "16:9";
    personGeneration: "dont_allow" | "allow_adult";
    numberOfVideos: number;
    durationSeconds: number;
    negativePrompt?: string | undefined;
}, {
    prompt: string;
    aspectRatio?: "1:1" | "9:16" | "16:9" | undefined;
    negativePrompt?: string | undefined;
    personGeneration?: "dont_allow" | "allow_adult" | undefined;
    numberOfVideos?: number | undefined;
    durationSeconds?: number | undefined;
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
