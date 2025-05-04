import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { GEMINI_API_KEY } from '../config.js'; // Only need API Key

// --- Define Schema ---
export const listFilesSchema = z.object({
    // Adding an optional description parameter for clarity, though not used by the API call itself.
    description: z.string().optional().describe("Optional description for the purpose of this Google Gemini File API listing request (not sent to API).")
});

// --- Define Response Interface (Based on example) ---
interface FileListItem {
    name: string;
    displayName?: string;
    mimeType?: string;
    sizeBytes?: string;
    createTime?: string;
    updateTime?: string;
    expirationTime?: string;
    sha256Hash?: string;
    uri?: string;
    state?: string;
    videoMetadata?: any; // Keep as any for flexibility
    source?: string;
}
interface ListFilesApiResponse {
    files?: FileListItem[];
    // Potentially nextPageToken if pagination exists, but not shown in example
}

/**
 * Handles the request to list files uploaded via the Google File API.
 */
export async function handleListFiles(
    params: z.infer<typeof listFilesSchema>, // Params will be empty object
    axiosInstance: any // Use 'any' type consistent with other tools
): Promise<{ content: Array<TextContent> }> {
    const listFilesUrl = `/v1beta/files?key=${GEMINI_API_KEY}`; // Relative path for axiosInstance

    try {
        console.log(`[listFiles] Fetching file list from Gemini File API... URL: ${axiosInstance.defaults.baseURL}${listFilesUrl}`);
        // Use GET request with the shared axiosInstance
        const response = await axiosInstance.get(listFilesUrl);
        const responseData = response.data as ListFilesApiResponse;

        if (responseData.files && responseData.files.length > 0) {
            console.log(`[listFiles] Found ${responseData.files.length} file(s).`);
            // Format the output nicely
            const formattedList = responseData.files.map(file => (
                `Name: ${file.name}\n` +
                `  Display Name: ${file.displayName || 'N/A'}\n` +
                `  MIME Type: ${file.mimeType || 'N/A'}\n` +
                `  Size: ${file.sizeBytes || 'N/A'} bytes\n` +
                `  State: ${file.state || 'N/A'}\n` +
                `  URI: ${file.uri || 'N/A'}\n` +
                `  Expires: ${file.expirationTime || 'N/A'}`
            )).join('\n--------------------\n');

            return { content: [{ type: 'text', text: `Uploaded Files:\n--------------------\n${formattedList}` }] };
        } else {
            console.log('[listFiles] No files found.');
            return { content: [{ type: 'text', text: 'No files found in the Google File API storage.' }] };
        }

    } catch (error: unknown) {
        console.error('[listFiles] Error fetching file list:', error);
        let errorMessage = 'An unknown error occurred while fetching the file list.';
        const err = error as any;
        if (err.response && err.message) {
             const responseInfo = err.response ? ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}` : 'No response data.';
             errorMessage = `API request failed: ${err.message}.${responseInfo}`;
        } else if (err.message) {
            errorMessage = err.message;
        } else {
             errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        return { content: [{ type: 'text', text: `Error listing files: ${errorMessage}` }] };
    }
}
