import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const understandMediaSchema: z.ZodEffects<z.ZodObject<{
    text: z.ZodString;
    url: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text: string;
    path?: string | undefined;
    url?: string | undefined;
}, {
    text: string;
    path?: string | undefined;
    url?: string | undefined;
}>, {
    text: string;
    path?: string | undefined;
    url?: string | undefined;
}, {
    text: string;
    path?: string | undefined;
    url?: string | undefined;
}>;
export declare const understandMediaShape: {
    text: z.ZodString;
    url: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
};
type UnderstandMediaParams = z.infer<typeof understandMediaSchema>;
/**
 * Handles the media understanding tool request.
 * Note: The input 'params' type might technically be inferred from the base shape used in registration,
 * but the refined schema logic is handled by the MCP SDK before this handler is called.
 */
export declare function handleUnderstandMedia(params: UnderstandMediaParams, // Keep using the refined type here for clarity within the handler
axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
