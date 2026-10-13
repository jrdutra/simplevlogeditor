package com.simplevlogeditor.mobile;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Serves the Angular bundle at an HTTPS origin, including SPA route reloads. */
final class BundledWeb {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final String HOME = ORIGIN + "/";
    private final WebViewAssetLoader loader;

    BundledWeb(AssetManager assets) {
        loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", path -> load(assets, path))
                .build();
    }

    static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    WebResourceResponse intercept(Uri uri) {
        return isLocal(uri) ? loader.shouldInterceptRequest(uri) : null;
    }

    private WebResourceResponse load(AssetManager assets, String path) {
        for (String segment : path.split("/")) {
            if (segment.equals("..") || segment.equals(".") || segment.contains("\\")) {
                return missing();
            }
        }
        String file = path.isEmpty() ? "index.html" : path;
        try {
            return response(mime(file), 200, "OK", assets.open("web/" + file));
        } catch (IOException missingAsset) {
            // Only application routes use the SPA fallback. A missing model,
            // worker, script or asset must never receive HTML with a 200 status.
            if (!path.startsWith("assets/") && !path.contains(".")) {
                try {
                    return response("text/html", 200, "OK", assets.open("web/index.html"));
                } catch (IOException ignored) { /* Return a real 404 below. */ }
            }
            return missing();
        }
    }

    private static WebResourceResponse missing() {
        return response("text/plain", 404, "Not Found",
                new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
    }

    private static WebResourceResponse response(String mime, int status, String reason, InputStream data) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cross-Origin-Opener-Policy", "same-origin");
        headers.put("Cross-Origin-Embedder-Policy", "require-corp");
        headers.put("Cross-Origin-Resource-Policy", "same-origin");
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse(mime, "UTF-8", status, reason, headers, data);
    }

    private static String mime(String file) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(file).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "js": case "mjs": return "text/javascript";
            case "wasm": return "application/wasm";
            case "onnx": case "bin": return "application/octet-stream";
            case "json": case "webmanifest": return "application/json";
            case "svg": return "image/svg+xml";
            default:
                String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return type != null ? type : "application/octet-stream";
        }
    }
}
