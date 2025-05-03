import { z } from 'zod';
import { GEMINI_API_KEY, GEMINI_SEARCH_MODEL, REQUEST_TIMEOUT } from '../config.js'; // Import necessary config
// --- Define Input Schema ---
export const webSearchSchema = z.object({
    query: z.string().min(1).describe("Required. The search query or question for the Google Gemini web search service. (English is recommended for best results)."),
}).describe("Performs a web search using the Google Gemini Search Retrieval tool and returns the answer along with search sources.");
/**
 * Handles the web search tool request.
 */
export async function handleWebSearch(params, axiosInstance // Use 'any' type consistent with other tools
) {
    const { query } = params;
    const model = GEMINI_SEARCH_MODEL; // Use configured search model
    const apiUrl = `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    // Add a prefix to encourage web search
    const prefixedQuery = `Please search the internet for the following questions: ${query}`;
    const requestPayload = {
        contents: [{ parts: [{ text: prefixedQuery }] }], // Use the prefixed query
        tools: [{
                google_search: {}
            }]
    };
    try {
        console.log(`[webSearch] Sending search query "${query}" to model ${model}... URL: ${axiosInstance.defaults.baseURL}${apiUrl}`);
        const response = await axiosInstance.post(apiUrl, requestPayload, { timeout: REQUEST_TIMEOUT });
        const responseData = response.data;
        // Extract answer text
        const answerText = responseData.candidates?.[0]?.content?.parts?.[0]?.text || "No answer text found.";
        // Extract sources
        const sources = [];
        const groundingChunks = responseData.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (groundingChunks) {
            for (const chunk of groundingChunks) {
                if (chunk.web) {
                    sources.push({
                        title: chunk.web.title,
                        uri: chunk.web.uri,
                    });
                }
            }
        }
        const result = {
            answerText: answerText,
            sources: sources,
        };
        console.log('[webSearch] Tool execution successful.');
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        console.error('[webSearch] Error during web search:', error);
        let errorMessage = 'An unknown error occurred during web search.';
        const err = error;
        if (err.response && err.message) {
            const responseInfo = err.response ? ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}` : 'No response data.';
            errorMessage = `API request failed: ${err.message}.${responseInfo}`;
        }
        else if (err.message) {
            errorMessage = err.message;
        }
        else {
            errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        return { content: [{ type: 'text', text: `Error performing web search: ${errorMessage}` }] };
    }
}
//# sourceMappingURL=webSearch.js.map