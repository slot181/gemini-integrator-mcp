import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const understandMediaShape: {
    text: z.ZodString;
    file_url: z.ZodOptional<z.ZodString>;
    file_path: z.ZodOptional<z.ZodString>;
    file_api_uri: z.ZodOptional<z.ZodString>;
    file_mime_type: z.ZodOptional<z.ZodString>;
};
export declare const understandMediaSchema: z.ZodEffects<z.ZodObject<{
    text: z.ZodString;
    file_url: z.ZodOptional<z.ZodString>;
    file_path: z.ZodOptional<z.ZodString>;
    file_api_uri: z.ZodOptional<z.ZodString>;
    file_mime_type: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text: string;
    file_url?: string | undefined;
    file_path?: string | undefined;
    file_api_uri?: string | undefined;
    file_mime_type?: string | undefined;
}, {
    text: string;
    file_url?: string | undefined;
    file_path?: string | undefined;
    file_api_uri?: string | undefined;
    file_mime_type?: string | undefined;
}>, {
    text: string;
    file_url?: string | undefined;
    file_path?: string | undefined;
    file_api_uri?: string | undefined;
    file_mime_type?: string | undefined;
}, {
    text: string;
    file_url?: string | undefined;
    file_path?: string | undefined;
    file_api_uri?: string | undefined;
    file_mime_type?: string | undefined;
}>;
type UnderstandMediaParams = z.infer<typeof understandMediaSchema>;
/**
 * Handles the media understanding tool request for multiple files.
 */
export declare function handleUnderstandMedia(params: UnderstandMediaParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
