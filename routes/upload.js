const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { randomUUID } = require('crypto');

const supabase = require('../supabase');
const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();
const BUCKET = 'product-images';

const receiveImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024,
    files: 1,
    fields: 1,
    parts: 2
  }
}).single('image');

router.use(requireAuth, requireRole('Admin'));

router.post('/', (req, res) => {
  receiveImage(req, res, error => {
    if (error) {
      return res.status(400).json({
        error: error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be smaller than 3 MB'
          : 'Upload one image and one product_id field'
      });
    }

    return saveProductImage(req, res);
  });
});

async function saveProductImage(req, res) {
  const rawId = req.body?.product_id;
  const productId = Number(rawId);

  if (
    typeof rawId !== 'string' ||
    !/^[1-9]\d*$/.test(rawId) ||
    !Number.isSafeInteger(productId) ||
    productId > 2147483647
  ) {
    return res.status(400).json({
      error: 'A valid product_id is required'
    });
  }

  if (!req.file) {
    return res.status(400).json({
      error: 'Select an image using the image field'
    });
  }

  let uploadedPath = null;
  let imageLinked = false;

  try {
    const { data: product, error: productError } = await req.db
      .from('products')
      .select('id')
      .eq('id', productId)
      .eq('is_active', true)
      .maybeSingle();

    if (productError) {
      throw productError;
    }

    if (!product) {
      return res.status(404).json({
        error: 'Active product not found'
      });
    }

    let imageBuffer;

    try {
      const image = sharp(req.file.buffer, {
        limitInputPixels: 16000000
      });

      const metadata = await image.metadata();

      if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
        return res.status(400).json({
          error: 'Only JPEG, PNG, and WebP images are supported'
        });
      }

      if ((metadata.pages || 1) > 1) {
        return res.status(400).json({
          error: 'Use a still image instead of an animated image'
        });
      }

      imageBuffer = await image
        .rotate()
        .resize({
          width: 1000,
          height: 1000,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      return res.status(400).json({
        error: 'Invalid image or image exceeds 16 million pixels'
      });
    }

    if (imageBuffer.length > 3 * 1024 * 1024) {
      return res.status(400).json({
        error: 'Processed image is too large'
      });
    }

    const path = `${req.user.shop_id}/${productId}/${randomUUID()}.webp`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, imageBuffer, {
        contentType: 'image/webp',
        upsert: false
      });

    if (uploadError) {
      throw uploadError;
    }

    uploadedPath = path;

    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(path);

    const { data: updatedProduct, error: updateError } =
      await req.db
        .from('products')
        .update({ image: urlData.publicUrl })
        .eq('id', productId)
        .eq('is_active', true)
        .select('id, name, image')
        .maybeSingle();

    if (updateError) {
      throw updateError;
    }

    if (!updatedProduct) {
      throw new Error('Product is no longer available');
    }

    imageLinked = true;

    return res.status(201).json({
      message: 'Product image uploaded',
      url: updatedProduct.image,
      product: updatedProduct
    });
  } catch (error) {
    console.error('Image upload failed:', error.message);

    if (uploadedPath && !imageLinked) {
      try {
        const { error: cleanupError } = await supabase.storage
          .from(BUCKET)
          .remove([uploadedPath]);

        if (cleanupError) {
          console.error('Upload cleanup failed:', cleanupError.message);
        }
      } catch (cleanupError) {
        console.error('Upload cleanup failed:', cleanupError.message);
      }
    }

    return res.status(500).json({
      error: 'Unable to save the product image'
    });
  }
}

module.exports = router;