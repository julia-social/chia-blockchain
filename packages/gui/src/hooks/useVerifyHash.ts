import { useState, useEffect } from 'react';
import { type NFTInfo } from '@chia/api';
import { useLocalStorage } from '@chia/core';
import isURL from 'validator/lib/isURL';

import getRemoteFileContent from '../util/getRemoteFileContent';
import { MAX_FILE_SIZE } from './useNFTMetadata';
import {
  mimeTypeRegex,
  isImage,
  getCacheInstances,
  parseExtensionFromUrl,
  toBase64Safe,
  fromBase64Safe,
} from '../util/utils';
import { FileType } from '../util/getRemoteFileContent';

const ipcRenderer = (window as any).ipcRenderer;

function isAudio(uri: string) {
  return mimeTypeRegex(uri, /^audio/);
}

type VerifyHash = {
  nft: NFTInfo;
  ignoreSizeLimit: boolean;
  metadata?: any;
  metadataError?: any;
  isPreview: boolean;
  dataHash: string;
  nftId: string;
  validateNFT: boolean;
};

let encoding: string = 'binary';

export default function useVerifyHash(props: VerifyHash): {
  isValid: boolean;
  isLoading: boolean;
  error: string | undefined;
  thumbnail: any;
  isValidationProcessed: boolean;
  validateNFT: boolean;
  encoding: string;
} {
  const {
    nft,
    ignoreSizeLimit,
    metadata,
    metadataError,
    isPreview,
    dataHash,
    nftId,
    validateNFT,
  } = props;
  const [isValid, setIsValid] = useState(false);
  const [isValidationProcessed, setIsValidationProcessed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [thumbnail, setThumbnail] = useState({});
  const [thumbCache, setThumbCache] = useLocalStorage(
    `thumb-cache-${nftId}`,
    {},
  );
  const [contentCache, setContentCache] = useLocalStorage(
    `content-cache-${nftId}`,
    {},
  );
  const [forceReloadNFT] = useLocalStorage(`force-reload-${nftId}`, false);

  const uri = nft.dataUris?.[0];

  let lastError: any;

  async function validateHash(metadata: any): Promise<void> {
    let uris: string[] = [];
    let videoThumbValid: boolean = false;

    setError(undefined);
    setIsLoading(true);
    setIsValid(false);

    if (metadata.preview_video_uris && !metadata.preview_video_hash) {
      setIsLoading(false);
      lastError = 'missing preview_video_hash';
    } else if (metadata.preview_image_uris && !metadata.preview_image_hash) {
      setIsLoading(false);
      setIsValid(false);
      lastError = 'missing preview_image_hash';
    } else {
      /* ================== VIDEO THUMBNAIL ================== */
      if (metadata['preview_video_uris']) {
        /* if it's cached, don't try to validate hash at all */
        if (thumbCache.video) {
          setThumbnail({
            video: `cached://${fromBase64Safe(thumbCache.video)}`,
          });
          setIsLoading(false);
          videoThumbValid = true;
          return;
        } else {
          uris = metadata['preview_video_uris'];
          for (let i = 0; i < uris.length; i++) {
            const videoUri = uris[i];
            try {
              if (!isURL(videoUri)) {
                lastError = 'Invalid URI';
              }
              const { isValid, wasCached } = await getRemoteFileContent({
                uri: videoUri,
                forceCache: true,
                nftId,
                type: FileType.Video,
                dataHash: metadata['preview_video_hash'],
              });

              ipcRenderer.invoke('adjustCacheLimitSize', {
                cacheInstances: getCacheInstances(),
              });

              if (!isValid) {
                lastError = 'thumbnail hash mismatch';
              }
              if (isValid) {
                videoThumbValid = true;
                const cachedUri = `${nftId}_${videoUri}`;
                setThumbnail({
                  video: wasCached ? `cached://${cachedUri}` : videoUri,
                });
                if (wasCached) {
                  setThumbCache({
                    video: toBase64Safe(cachedUri),
                    time: new Date().getTime(),
                  });
                }
                setIsLoading(false);
                lastError = null;
                return;
              }
            } catch (e: any) {
              /* if we already found content that is hash mismatched, show mismatch error! */
              lastError = lastError || 'failed fetch content';
            }
          }
        }
      }

      /* ================== IMAGE THUMBNAIL ================== */
      if (metadata['preview_image_uris'] && !videoThumbValid) {
        let showCachedUri: boolean = false;
        uris = metadata['preview_image_uris'];
        for (let i = 0; i < uris.length; i++) {
          const imageUri = uris[i];
          /* if it's cached, don't try to validate hash at all */
          if (thumbCache.image) {
            lastError = null;
            setThumbnail({
              image: `cached://${fromBase64Safe(thumbCache.image)}`,
            });
            setIsLoading(false);
            return;
          }

          try {
            if (!isURL(imageUri)) {
              lastError = 'Invalid URI';
            }
            const { wasCached, isValid } = await getRemoteFileContent({
              uri: imageUri,
              forceCache: true,
              nftId,
              dataHash: metadata['preview_image_hash'],
              type: FileType.Image,
            });
            if (isValid) {
              const cachedImageUri = `${nftId}_${imageUri}`;
              if (wasCached) {
                setThumbCache({
                  image: toBase64Safe(cachedImageUri),
                  time: new Date().getTime(),
                });
              }
              setThumbnail({
                image: wasCached ? `cached://${cachedImageUri}` : imageUri,
              });
              setIsLoading(false);
              return;
            }
          } catch (e: any) {
            /* if we already found content that is hash mismatched, show mismatch error! */
            lastError = lastError || 'failed fetch content';
          }
        }
      }

      /* ================== BINARY CONTENT ================== */
      if (isImage(uri) || !isPreview) {
        let showCachedUri: boolean = false;
        if (contentCache.binary) {
          if (parseExtensionFromUrl(uri) === 'svg') {
            const svgContent = await ipcRenderer.invoke(
              'getSvgContent',
              contentCache.binary,
            );
            setThumbnail({
              binary: svgContent,
            });
          } else {
            setThumbnail({
              binary: `cached://${fromBase64Safe(contentCache.binary)}`,
            });
          }
          if (contentCache.valid === false) {
            lastError = 'Hash mismatch';
          }
        } else {
          try {
            const {
              encoding: fileEncoding,
              wasCached,
              isValid,
            } = await getRemoteFileContent({
              uri,
              maxSize:
                ignoreSizeLimit || validateNFT ? Infinity : MAX_FILE_SIZE,
              forceCache: true,
              nftId,
              type: FileType.Binary,
              dataHash,
            });

            showCachedUri = wasCached;

            ipcRenderer.invoke('adjustCacheLimitSize', {
              cacheInstances: getCacheInstances(),
            });

            encoding = fileEncoding;

            if (!isValid) {
              lastError = 'Hash mismatch';
            }
          } catch (e: any) {
            lastError = e.message;
          }
          if (!lastError || lastError === 'Hash mismatch') {
            const cachedBinaryUri = `${nftId}_${uri}`;
            setContentCache({
              nftId,
              binary: showCachedUri ? toBase64Safe(cachedBinaryUri) : null,
              valid: !lastError,
              time: new Date().getTime(),
            });
            setThumbnail({
              binary: showCachedUri ? `cached://${cachedBinaryUri}` : uri,
            });
          }
        }
      }
    }
    setIsValid(!lastError);
    if (lastError) {
      setError(lastError);
    }
    setIsLoading(false);
    setIsValidationProcessed(true);
  }

  function checkBinaryCache() {
    if (contentCache.binary) {
      setThumbnail({
        binary: `cached://${fromBase64Safe(contentCache.binary)}`,
      });
      if (contentCache.valid === false) {
        lastError = 'Hash mismatch';
      }
    }
  }

  useEffect(() => {
    if (metadata && !metadataError && (isPreview || isAudio(uri))) {
      validateHash(metadata);
    } else if (isImage(uri) || validateNFT) {
      validateHash({});
    } else if (!isPreview) {
      checkBinaryCache();
    } else {
      setIsLoading(false);
      setIsValid(false);
    }
    if (contentCache.valid) {
      setIsValid(true);
    }
  }, [metadata, uri, ignoreSizeLimit, forceReloadNFT, validateNFT]);

  return {
    isValid,
    isLoading: isPreview ? isLoading : false,
    error,
    thumbnail,
    isValidationProcessed,
    validateNFT,
    encoding,
  };
}
