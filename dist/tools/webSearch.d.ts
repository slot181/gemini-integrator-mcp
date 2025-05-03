import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const webSearchSchema: z.ZodObject<{
    query: z.ZodString;
}, "strip", z.ZodTypeAny, {
    query: string;
}, {
    query: string;
}>;
type WebSearchParams = z.infer<typeof webSearchSchema>;
/**
 * Handles the web search tool request.
 */
export declare function handleWebSearch(params: WebSearchParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
