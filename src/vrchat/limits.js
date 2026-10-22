'use strict';
// Avatar bundle size limits, as enforced by the VRChat SDK before it uploads (VRCSDKBase-Editor:
// ValidationHelpers.GetAssetBundleSizeLimit). VRChat's servers apply the same limits, and an
// avatar over them is reported as "Security Checks Failed" and cannot be worn.
const MB = 1024 * 1024;

const LIMITS = {
  pc: { download: 200 * MB, uncompressed: 500 * MB },
  mobile: { download: 10 * MB, uncompressed: 40 * MB },
};

/** Android and iOS builds are held to the mobile limits. */
const isMobile = (platform) => platform === 'android' || platform === 'ios';
const limitsFor = (platform) => (isMobile(platform) ? LIMITS.mobile : LIMITS.pc);

const formatSize = (bytes) => (bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`);

/**
 * @param {{ platform: string, fileSize: number, uncompressedSize?: number }} o
 * @returns {{ limits: {download:number, uncompressed:number}, downloadOver: boolean, uncompressedOver: boolean }}
 */
function checkBundleSize({ platform, fileSize, uncompressedSize = 0 }) {
  const limits = limitsFor(platform);
  return { limits, downloadOver: fileSize > limits.download, uncompressedOver: uncompressedSize > limits.uncompressed };
}

module.exports = { LIMITS, isMobile, limitsFor, formatSize, checkBundleSize };
