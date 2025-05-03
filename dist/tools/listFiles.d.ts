import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const listFilesSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    description?: string | undefined;
}, {
    description?: string | undefined;
}>;
/**
 * Handles the request to list files uploaded via the Google File API.
 */
export declare function handleListFiles(params: z.infer<typeof listFilesSchema>, // Params will be empty object
axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
