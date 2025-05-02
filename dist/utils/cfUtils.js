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
exports.uploadToCfImgbed = uploadToCfImgbed;
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const fs = __importStar(require("fs/promises")); // Needed to read file for upload
const path = __importStar(require("path"));
// Import necessary configuration
const config_1 = require("../config"); // Adjust path to config
/**
 * Uploads a file (image or video) from a local path to Cloudflare ImgBed.
 *
 * @param filePath The local path to the file to upload.
 * @returns The public URL of the uploaded file on CF ImgBed, or null if upload fails or is skipped.
 */
async function uploadToCfImgbed(filePath) {
    if (!config_1.CF_IMGBED_UPLOAD_URL || !config_1.CF_IMGBED_API_KEY) {
        console.warn('[cfUtils] CF ImgBed URL or API Key not configured. Skipping upload.');
        return null;
    }
    const filename = path.basename(filePath);
    let fileData;
    try {
        fileData = await fs.readFile(filePath);
    }
    catch (readError) {
        console.error(`[cfUtils] Error reading file for upload ${filePath}:`, readError);
        return null; // Cannot upload if file cannot be read
    }
    const form = new form_data_1.default();
    form.append('file', fileData, filename); // Use the buffer and original filename
    // Construct the upload URL with the API key as 'authCode' query parameter
    const separator = config_1.CF_IMGBED_UPLOAD_URL.includes('?') ? '&' : '?';
    const uploadUrlWithAuth = `${config_1.CF_IMGBED_UPLOAD_URL}${separator}authCode=${config_1.CF_IMGBED_API_KEY}`;
    try {
        console.info(`[cfUtils] Uploading file '${filename}' from '${filePath}' to CF ImgBed...`);
        const response = await axios_1.default.post(uploadUrlWithAuth, form, {
            headers: {
                ...form.getHeaders(), // Important for multipart/form-data
            },
            timeout: config_1.REQUEST_TIMEOUT, // Use configured timeout
        });
        // Check response based on typical ImgBed success structure
        if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0 && response.data[0]?.src) {
            const imagePathSegment = response.data[0].src;
            // Construct the full URL based on the upload URL's origin
            const parsedUploadUrl = new URL(config_1.CF_IMGBED_UPLOAD_URL);
            const baseUrlStr = `${parsedUploadUrl.protocol}//${parsedUploadUrl.host}`;
            const fullUrl = new URL(imagePathSegment, baseUrlStr).toString();
            console.info(`[cfUtils] File uploaded successfully to CF ImgBed: ${fullUrl}`);
            return fullUrl;
        }
        else {
            console.error(`[cfUtils] Unexpected response format from ImgBed. Status: ${response.status}. Data: ${JSON.stringify(response.data)}`);
            return null;
        }
    }
    catch (error) { // Catch as unknown
        let errorMessage = 'Unknown error during ImgBed upload.';
        // Check if it's an object and has expected properties
        if (typeof error === 'object' && error !== null) {
            const err = error; // Use 'any' for property checking
            if (err.response && err.message) { // Check for Axios-like properties
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            }
            else if (err.message) { // Generic Error object
                errorMessage = `Error: ${err.message}`;
            }
            else {
                errorMessage = `Caught non-standard error object: ${JSON.stringify(error)}`;
            }
        }
        else {
            errorMessage = `Caught non-object error: ${String(error)}`;
        }
        console.error(`[cfUtils] Failed to upload file to ImgBed: ${errorMessage}`);
        return null;
    }
}
//# sourceMappingURL=cfUtils.js.map