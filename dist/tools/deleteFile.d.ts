import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const deleteFileSchema: z.ZodObject<{
    fileName: z.ZodString;
}, "strip", z.ZodTypeAny, {
    fileName: string;
}, {
    fileName: string;
}>;
type DeleteFileParams = z.infer<typeof deleteFileSchema>;
/**
 * Handles the request to delete a file from the Google File API storage.
 */
export declare function handleDeleteFile(params: DeleteFileParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
