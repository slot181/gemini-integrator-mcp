"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.editImageShape = exports.editImageSchema = void 0;
exports.handleEditImage = handleEditImage;
const zod_1 = require("zod");
const axios_1 = __importDefault(require("axios")); // Keep default import
// Remove AxiosInstance type import
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises")); // Use fsPromises alias
const fs = __importStar(require("fs")); // Import the core fs module
const crypto = __importStar(require("crypto")); // For generating temp filenames
// Import shared utilities and config
const fileUtils_1 = require("../utils/fileUtils");
const cfUtils_1 = require("../utils/cfUtils");
const config_1 = require("../config");
// Define the base object schema first
const editImageBaseSchema = zod_1.z.object({
    prompt: zod_1.z.string().min(1, "Prompt cannot be empty"),
    image_url: zod_1.z.string().url("Invalid URL provided for image_url").optional(),
    image_path: zod_1.z.string().min(1, "Image path cannot be empty").optional(),
    // Add other potential Gemini parameters as needed
});
// Define the refined schema for validation logic
exports.editImageSchema = editImageBaseSchema.refine(data => !!data.image_url !== !!data.image_path, {
    message: "Provide either image_url or image_path, but not both.",
    path: ["image_url", "image_path"], // Indicate which fields this refinement relates to
});
// Export the base shape specifically for tool registration
exports.editImageShape = editImageBaseSchema.shape;
// Helper function to download an image from a URL to a temporary file
async function downloadImageToTemp(url, tempDir) {
    const tempDirPath = path.resolve(config_1.DEFAULT_OUTPUT_DIR, tempDir);
    await fsPromises.mkdir(tempDirPath, { recursive: true }); // Use fsPromises.mkdir
    const randomFilename = crypto.randomBytes(16).toString('hex'); // Generate random name
    const tempFilePath = path.join(tempDirPath, randomFilename); // Initial path without extension
    let finalPath = tempFilePath; // Path might change based on mime type
    let detectedMimeType = null;
    try {
        console.log(`[editImage] Downloading image from URL: ${url}`);
        const response = await (0, axios_1.default)({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: config_1.REQUEST_TIMEOUT,
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
            await (0, fileUtils_1.deleteFile)(finalPath).catch(e => console.error(`[editImage] Error cleaning up temp file ${finalPath} after download error:`, e));
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
async function handleEditImage(params, axiosInstance // Use 'any' to bypass Axios type issues
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
        const apiUrl = `/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${config_1.GEMINI_API_KEY}`;
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
            generationConfig: { responseModalities: ["IMAGE"] } // Expecting an image back
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
        const uniqueFilename = (0, fileUtils_1.generateUniqueFilename)('gemini-edit', `.${editedFileExtension}`);
        const localImagePath = await (0, fileUtils_1.saveFile)(config_1.DEFAULT_OUTPUT_DIR, outputSubDir, uniqueFilename, editedImageData);
        console.log(`[editImage] Edited image saved locally to: ${localImagePath}`);
        // --- Upload to CF ImgBed (if configured) ---
        let cfImageUrl = null;
        let cfUploadSuccess = false;
        try {
            cfImageUrl = await (0, cfUtils_1.uploadToCfImgbed)(localImagePath);
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
            await (0, fileUtils_1.deleteFile)(sourceImagePath).catch(e => console.error(`[editImage] Error cleaning up temp file ${sourceImagePath}:`, e));
        }
    }
}
//# sourceMappingURL=editImage.js.map