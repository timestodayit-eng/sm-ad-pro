# Cloudflare R2 setup (media library)

Videos and images upload straight from the browser to R2 (multipart, up to 1 GiB, resumable). They never pass
through the Node server, so Hostinger upload limits do not apply.

## 1. Bucket

Cloudflare dashboard → R2 → bucket **`smdb`** (already exists). Files go under the prefix `coastal-media/`
(`R2_PREFIX`), so other content in the bucket is left alone.

## 2. API token

R2 → Manage R2 API Tokens → Create API token.

- Permission: **Object Read & Write**
- Specify bucket: **smdb** only

Copy the **Access Key ID** and **Secret Access Key** into `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
Your **Account ID** (right side of the R2 overview page) goes into `R2_ACCOUNT_ID`.

## 3. CORS on the bucket

Bucket → Settings → CORS policy:

```json
[
  {
    "AllowedOrigins": ["https://proads.smenterpriserl1987.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Keep `ExposeHeaders: ETag`: the storage check expects it, and it lets the browser confirm each part it sent.
Set `R2_ALLOWED_ORIGINS` to the same origin(s).

## 4. Check

Open **Media Library** and press **Check storage connection**. It proves five things in order:

1. The server can reach the bucket with these keys.
2. The bucket CORS policy allows this panel (skipped if the token cannot read bucket settings).
3. This browser uploaded a small test file straight to R2.
4. The browser could read the `ETag` header.
5. The server found the test file, then deleted it.

System Health shows **Browser uploads (CORS)** as *Verified* once this passes, and asks you to re-run it after 7 days.

## How uploads work

- Videos are split into 8 MB parts and sent 4 at a time straight to R2 through links that expire after an hour.
- **Pause** stops sending. **Resume** asks R2 which parts already arrived and sends only the rest.
- If the browser closes or crashes, pick the same file again within 6 days and it continues where it stopped.
- The server marks a file ready only after it has listed every part in R2, completed the upload and checked the final size.
- Unfinished uploads older than 6 days are cleaned up automatically (R2 itself drops them at 7).
- Thumbnails, dimensions and length are worked out in the browser, so the server never downloads the video.
- Deleting a file removes it from R2. Ads already published keep working, because Meta keeps its own copy.

## Optional settings

| Key | Default | Use |
| --- | --- | --- |
| `R2_PREFIX` | `coastal-media/` | Folder inside the bucket for this panel's files |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | Only for an EU-jurisdiction bucket (`https://<account>.eu.r2.cloudflarestorage.com`) |
| `MEDIA_MAX_BYTES` | `1073741824` (1 GB) | Largest video accepted. Images are capped at 30 MB |
