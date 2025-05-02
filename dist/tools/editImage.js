import { z } from 'zod';
import axios from 'axios'; // Keep default import
// Remove AxiosInstance type import
import * as path from 'path';
import * as fsPromises from 'fs/promises'; // Use fsPromises alias
import * as fs from 'fs'; // Import the core fs module
import * as crypto from 'crypto'; // For generating temp filenames
// Import shared utilities and config
import { saveFile, generateUniqueFilename, deleteFile } from '../utils/fileUtils.js'; // Add .js extension
import { uploadToCfImgbed } from '../utils/cfUtils.js'; // Add .js extension
import { GEMINI_API_KEY, DEFAULT_OUTPUT_DIR, REQUEST_TIMEOUT } from '../config.js'; // Add .js extension
// Define the base object schema first
const editImageBaseSchema = z.object({
    prompt: z.string().min(1).describe("Instructions for how to edit the provided image."), // Moved description
    image_url: z.string().url().optional().describe("URL of the image to edit."), // Moved description
    image_path: z.string().min(1).optional().describe("Local path to the image to edit."), // Moved description
    // Add other potential Gemini parameters as needed
});
// Define the refined schema for validation logic
export const editImageSchema = editImageBaseSchema.refine(data => !!data.image_url !== !!data.image_path, {
    message: "Provide either image_url or image_path, but not both.",
    path: ["image_url", "image_path"], // Indicate which fields this refinement relates to
});
// Export the base shape specifically for tool registration
export const editImageShape = editImageBaseSchema.shape;
// Helper function to download an image from a URL to a temporary file
async function downloadImageToTemp(url, tempDir) {
    const tempDirPath = path.resolve(DEFAULT_OUTPUT_DIR, tempDir);
    await fsPromises.mkdir(tempDirPath, { recursive: true }); // Use fsPromises.mkdir
    const randomFilename = crypto.randomBytes(16).toString('hex'); // Generate random name
    const tempFilePath = path.join(tempDirPath, randomFilename); // Initial path without extension
    let finalPath = tempFilePath; // Path might change based on mime type
    let detectedMimeType = null;
    try {
        console.log(`[editImage] Downloading image from URL: ${url}`);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT,
        });
        detectedMimeType = response.headers['content-type'] || null;
        if (detectedMimeType && detectedMimeType.startsWith('image/')) {
            const extension = detectedMimeType.split('/')[1] || 'tmp';
            finalPath = `${tempFilePath}.${extension}`; // Add extension based on mime type
        }
        else {
            finalPath = `${tempFilePath}.tmp`; // Fallback extension
            console.warn(`[editImage] Could not determine image mime type from URL response headers. Content-Type: ${detectedMimeType}. Saving as .tmp`);
            // Keep detectedMimeType potentially non-image for error handling later
        }
        const writer = fs.createWriteStream(finalPath); // Use fs.createWriteStream
        const stream = response.data; // Type assertion for stream
        stream.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            // Pass the error object to reject
            writer.on('error', (err) => reject(err));
            stream.on('error', (err) => reject(err)); // Also handle stream errors
        });
        console.log(`[editImage] Image downloaded successfully to temporary path: ${finalPath}`);
        return { tempPath: finalPath, mimeType: detectedMimeType };
    }
    catch (error) {
        console.error(`[editImage] Failed to download image from ${url}:`, error);
        // Attempt cleanup if file was partially created
        if (finalPath) {
            await deleteFile(finalPath).catch(e => console.error(`[editImage] Error cleaning up temp file ${finalPath} after download error:`, e));
        }
        throw new Error(`Failed to download image from URL: ${url}`);
    }
}
// Helper function to get MIME type and base64 data from a local file path
async function getImageDataFromPath(filePath) {
    try {
        const data = await fsPromises.readFile(filePath); // Use fsPromises.readFile
        const base64Data = data.toString('base64');
        // Basic MIME type detection based on extension - consider a more robust library if needed
        const extension = path.extname(filePath).toLowerCase();
        let mimeType = 'application/octet-stream'; // Default
        if (extension === '.png')
            mimeType = 'image/png';
        else if (extension === '.jpg' || extension === '.jpeg')
            mimeType = 'image/jpeg';
        else if (extension === '.gif')
            mimeType = 'image/gif';
        else if (extension === '.webp')
            mimeType = 'image/webp';
        // Add more types as needed
        if (mimeType === 'application/octet-stream') {
            console.warn(`[editImage] Could not determine specific image MIME type for path ${filePath} based on extension. Using default.`);
        }
        return { base64Data, mimeType };
    }
    catch (error) {
        console.error(`[editImage] Failed to read image file from path ${filePath}:`, error);
        throw new Error(`Failed to read image file: ${filePath}`);
    }
}
/**
 * Handles the image editing tool request.
 */
export async function handleEditImage(params, axiosInstance // Use 'any' to bypass Axios type issues
) {
    const { prompt, image_url, image_path } = params;
    const tempDir = 'tmp'; // Subfolder for temporary downloads
    const outputSubDir = 'image'; // Subfolder for final edited images
    let sourceImagePath = null;
    let sourceMimeType = null;
    let isTempFile = false;
    try {
        // --- Determine and prepare source image ---
        if (image_url) {
            const downloadResult = await downloadImageToTemp(image_url, tempDir);
            sourceImagePath = downloadResult.tempPath;
            sourceMimeType = downloadResult.mimeType;
            isTempFile = true;
            if (!sourceMimeType || !sourceMimeType.startsWith('image/')) {
                throw new Error(`Downloaded file from ${image_url} does not appear to be an image (MIME type: ${sourceMimeType}).`);
            }
        }
        else if (image_path) {
            sourceImagePath = path.resolve(image_path); // Resolve to absolute path if relative
            // Verify file exists before proceeding
            await fsPromises.access(sourceImagePath); // Use fsPromises.access
        }
        else {
            // This case should be prevented by the Zod refine validation, but handle defensively
            throw new Error("Internal error: No image source (URL or path) provided.");
        }
        // --- Get Base64 data and MIME type ---
        const { base64Data: sourceBase64, mimeType: finalMimeType } = await getImageDataFromPath(sourceImagePath);
        // Prefer MIME type detected during download if available and valid, otherwise use detection from path
        const effectiveMimeType = (sourceMimeType && sourceMimeType.startsWith('image/')) ? sourceMimeType : finalMimeType;
        if (!effectiveMimeType.startsWith('image/')) {
            throw new Error(`Invalid source image MIME type: ${effectiveMimeType}`);
        }
        // --- Call Gemini API ---
        console.log(`[editImage] Received edit request with prompt: "${prompt}" and image source: ${image_url || image_path}`);
        // Adjust model name if needed, assuming same endpoint as generation for editing
        const apiUrl = `/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${GEMINI_API_KEY}`;
        const requestPayload = {
            contents: [{
                    parts: [
                        { text: prompt },
                        {
                            inline_data: {
                                mime_type: effectiveMimeType,
                                data: sourceBase64
                            }
                        }
                    ]
                }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] } // Expecting an image back
        };
        console.log(`[editImage] Calling Gemini API at: ${axiosInstance.defaults.baseURL}${apiUrl}`);
        const response = await axiosInstance.post(apiUrl, requestPayload); // No type arg due to 'any'
        // --- Process Gemini Response ---
        const editedParts = response.data?.candidates?.[0]?.content?.parts;
        const editedImagePart = editedParts?.find((part) => part.inlineData && part.inlineData.mimeType.startsWith('image/'));
        if (!editedImagePart || !editedImagePart.inlineData) {
            console.error('[editImage] No edited image data found in Gemini response:', JSON.stringify(response.data));
            throw new Error('Gemini API did not return edited image data.');
        }
        const editedBase64Data = editedImagePart.inlineData.data;
        const editedMimeType = editedImagePart.inlineData.mimeType;
        const editedFileExtension = editedMimeType.split('/')[1] || 'png';
        const editedImageData = Buffer.from(editedBase64Data, 'base64');
        // --- Save Locally ---
        const uniqueFilename = generateUniqueFilename('gemini-edit', `.${editedFileExtension}`);
        const localImagePath = await saveFile(DEFAULT_OUTPUT_DIR, outputSubDir, uniqueFilename, editedImageData);
        console.log(`[editImage] Edited image saved locally to: ${localImagePath}`);
        // --- Upload to CF ImgBed (if configured) ---
        let cfImageUrl = null;
        let cfUploadSuccess = false;
        try {
            cfImageUrl = await uploadToCfImgbed(localImagePath);
            cfUploadSuccess = !!cfImageUrl;
        }
        catch (uploadError) {
            console.error(`[editImage] Error uploading edited image to CF ImgBed:`, uploadError);
        }
        // --- Return Result ---
        const result = {
            localPath: localImagePath,
            cfImageUrl: cfImageUrl,
            cfUploadSuccess: cfUploadSuccess,
        };
        console.log('[editImage] Tool execution successful:', result);
        // Return result as stringified JSON within a TextContent object
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        console.error('[editImage] Error during image editing:', error);
        let errorMessage = 'An unknown error occurred during image editing.';
        // Generic error checking
        if (typeof error === 'object' && error !== null) {
            const err = error;
            if (err.response && err.message) {
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            }
            else if (err.message) {
                errorMessage = `Error: ${err.message}`;
            }
            else {
                errorMessage = `Caught non-standard error object: ${JSON.stringify(error)}`;
            }
        }
        else {
            errorMessage = `Caught non-object error: ${String(error)}`;
        }
        // Ensure the error object matches TextContent structure
        return {
            content: [{ type: 'text', text: `Error editing image: ${errorMessage}` }]
        };
    }
    finally {
        // --- Cleanup ---
        if (isTempFile && sourceImagePath) {
            await deleteFile(sourceImagePath).catch(e => console.error(`[editImage] Error cleaning up temp file ${sourceImagePath}:`, e));
        }
    }
}
//# sourceMappingURL=editImage.js.map