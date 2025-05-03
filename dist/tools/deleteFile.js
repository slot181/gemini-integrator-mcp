import { z } from 'zod';
import { GEMINI_API_KEY } from '../config.js'; // Only need API Key
// --- Define Schema ---
export const deleteFileSchema = z.object({
    fileName: z.string().min(1).regex(/^files\/[a-zA-Z0-9]+$/, "fileName must be in the format 'files/xxxxxx'")
        .describe("Required. The relative name of the file to delete from the Google Gemini File API storage (e.g., 'files/kch7l0eddn96'). Get this from the listFiles tool."),
}).describe("Deletes a specific file from the Google Gemini File API storage using its relative name.");
/**
 * Handles the request to delete a file from the Google File API storage.
 */
export async function handleDeleteFile(params, axiosInstance // Use 'any' type consistent with other tools
) {
    const { fileName } = params;
    // Construct the relative path for the DELETE request
    const deleteFileUrl = `/v1beta/${fileName}?key=${GEMINI_API_KEY}`;
    try {
        console.log(`[deleteFile] Attempting to delete file: ${fileName}... URL: ${axiosInstance.defaults.baseURL}${deleteFileUrl}`);
        // Use DELETE request with the shared axiosInstance
        // A successful DELETE usually returns 200 OK or 204 No Content with an empty body
        const response = await axiosInstance.delete(deleteFileUrl);
        // Check for successful status codes
        if (response.status === 200 || response.status === 204) {
            console.log(`[deleteFile] Successfully deleted file: ${fileName}`);
            return { content: [{ type: 'text', text: `Successfully deleted file: ${fileName}` }] };
        }
        else {
            // This case might not be typical for DELETE, but handle defensively
            console.warn(`[deleteFile] Unexpected success status ${response.status} for deleting ${fileName}. Response:`, response.data);
            return { content: [{ type: 'text', text: `File deletion request sent for ${fileName}, but received unexpected status: ${response.status}` }] };
        }
    }
    catch (error) {
        console.error(`[deleteFile] Error deleting file ${fileName}:`, error);
        let errorMessage = `An unknown error occurred while deleting file ${fileName}.`;
        const err = error;
        // Check specifically for the permission denied/not found error structure
        if (err.response?.data?.error) {
            const apiError = err.response.data.error;
            errorMessage = `API Error (${apiError.status} - ${apiError.code}): ${apiError.message}`;
            console.error(`[deleteFile] API Error details:`, apiError);
            // Return the specific API error message
            return { content: [{ type: 'text', text: `Error deleting file ${fileName}: ${errorMessage}` }] };
        }
        // Fallback generic error handling
        else if (err.response && err.message) {
            const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
            errorMessage = `API request failed: ${err.message}.${responseInfo}`;
        }
        else if (err.message) {
            errorMessage = err.message;
        }
        else {
            errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        // Return the constructed error message
        return { content: [{ type: 'text', text: `Error deleting file ${fileName}: ${errorMessage}` }] };
    }
}
//# sourceMappingURL=deleteFile.js.map