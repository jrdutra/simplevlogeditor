package com.simplevlogeditor.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends ComponentActivity {
    private WebView webView;
    private FrameLayout root;
    private View fullScreen;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest audioRequest;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    // The output stream and URI are accessed only on the download executor.
    private OutputStream output;
    private Uri outputUri;
    private JavaScriptReplyProxy pickerReply;
    private int pickerId;
    private volatile boolean closing;

    private final ActivityResultLauncher<Intent> filePicker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                if (fileCallback == null) return;
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(
                        result.getResultCode(), result.getData()));
                fileCallback = null;
            });

    private final ActivityResultLauncher<String> audioPermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                PermissionRequest request = audioRequest;
                audioRequest = null;
                if (request == null) return;
                if (granted && BundledWeb.isLocal(request.getOrigin())) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else request.deny();
            });

    private final ActivityResultLauncher<Intent> savePicker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                JavaScriptReplyProxy reply = pickerReply;
                int id = pickerId;
                pickerReply = null;
                if (reply == null) return;
                Uri uri = result.getData() == null ? null : result.getData().getData();
                if (result.getResultCode() != RESULT_OK || uri == null) {
                    respond(reply, id, null, true);
                    return;
                }
                downloads.execute(() -> {
                    try {
                        outputUri = uri;
                        output = getContentResolver().openOutputStream(uri, "wt");
                        if (output == null) throw new IOException("Não foi possível abrir o destino.");
                        respond(reply, id, null, false);
                    } catch (IOException | SecurityException error) {
                        abortOutput();
                        respond(reply, id, error.getMessage(), false);
                    }
                });
            });

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(18, 18, 27));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        setContentView(root);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(18, 18, 27));
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Files selected through Android's document picker.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(true);

        BundledWeb bundled = new BundledWeb(getAssets());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return bundled.intercept(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (BundledWeb.isLocal(uri)) return false;
                if (request.isForMainFrame()) openExternal(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) toast(R.string.load_failed);
            }
        });
        webView.setWebChromeClient(new EditorChrome());
        webView.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (url.startsWith("blob:") || url.startsWith("data:") || BundledWeb.isLocal(Uri.parse(url))) {
                webView.evaluateJavascript("window.simpleVlogSaveDownload(" + JSONObject.quote(url)
                        + ", 'export')", null);
            } else openExternal(Uri.parse(url));
        });

        // Only the packaged app's top frame can save files. External pages and
        // iframes never receive a generic filesystem or JavaScript interface.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "SimpleVlogAndroid",
                    Collections.singleton(BundledWeb.ORIGIN), (view, message, origin, mainFrame, reply) -> {
                        if (!mainFrame || !BundledWeb.isLocal(origin)) return;
                        handleDownload(message.getData(), reply);
                    });
        } else {
            toast(R.string.webview_outdated);
            finish();
            return;
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (fullScreen != null) hideFullScreen();
                else if (webView.canGoBack()) webView.goBack();
                else finish();
            }
        });
        if (state == null || webView.restoreState(state) == null) webView.loadUrl(BundledWeb.HOME);
    }

    private void handleDownload(String data, JavaScriptReplyProxy reply) {
        int requestId = -1;
        try {
            if (data == null || data.length() > 300000) throw new JSONException("Mensagem inválida.");
            JSONObject message = new JSONObject(data);
            requestId = message.getInt("id");
            int id = requestId;
            String action = message.getString("action");
            if (action.equals("begin")) {
                if (pickerReply != null) {
                    respond(reply, id, "Já existe um salvamento em andamento.", false);
                    return;
                }
                String name = message.optString("name", "export").replaceAll("[\\\\/\\p{Cntrl}]", "_");
                if (name.trim().isEmpty()) name = "export";
                if (name.length() > 180) name = name.substring(name.length() - 180);
                String mime = message.optString("mime", "application/octet-stream").split(";", 2)[0];
                if (!mime.matches("[\\w.+-]+/[\\w.+-]+")) mime = "application/octet-stream";
                pickerReply = reply;
                pickerId = id;
                // Dispose any abandoned transfer before a new destination is opened.
                downloads.execute(this::abortOutput);
                try {
                    savePicker.launch(new Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE).setType(mime)
                            .putExtra(Intent.EXTRA_TITLE, name));
                } catch (ActivityNotFoundException error) {
                    pickerReply = null;
                    respond(reply, id, getString(R.string.no_file_picker), false);
                }
                return;
            }
            downloads.execute(() -> {
                try {
                    switch (action) {
                        case "chunk":
                            if (output == null) throw new IOException("Nenhum arquivo aberto para salvar.");
                            byte[] bytes = Base64.decode(message.getString("data"), Base64.NO_WRAP);
                            if (bytes.length > 192 * 1024) throw new IOException("Bloco de dados inválido.");
                            output.write(bytes);
                            break;
                        case "finish":
                            if (output == null) throw new IOException("Nenhum arquivo aberto para salvar.");
                            output.close();
                            output = null;
                            outputUri = null;
                            runOnUiThread(() -> toast(R.string.saved));
                            break;
                        case "abort": abortOutput(); break;
                        default: throw new IOException("Ação de salvamento inválida.");
                    }
                    respond(reply, id, null, false);
                } catch (IOException | JSONException | IllegalArgumentException error) {
                    abortOutput();
                    respond(reply, id, error.getMessage(), false);
                }
            });
        } catch (JSONException error) {
            respond(reply, requestId, error.getMessage(), false);
        }
    }

    private void abortOutput() {
        if (output != null) {
            try { output.close(); } catch (IOException ignored) { }
            output = null;
        }
        if (outputUri != null) {
            try { DocumentsContract.deleteDocument(getContentResolver(), outputUri); }
            catch (Exception ignored) { /* Some document providers cannot delete partial files. */ }
            outputUri = null;
        }
    }

    private void respond(JavaScriptReplyProxy reply, int id, String error, boolean canceled) {
        if (closing) return;
        JSONObject result = new JSONObject();
        try {
            result.put("id", id);
            if (error != null) result.put("error", error);
            if (canceled) result.put("canceled", true);
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
        runOnUiThread(() -> {
            if (!closing && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                reply.postMessage(result.toString());
            }
        });
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"mailto".equals(scheme)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { toast(R.string.no_browser); }
    }

    private void toast(int resource) { Toast.makeText(this, resource, Toast.LENGTH_LONG).show(); }

    private void hideFullScreen() {
        if (fullScreen == null) return;
        root.removeView(fullScreen);
        fullScreen = null;
        webView.setVisibility(View.VISIBLE);
        fullScreenCallback.onCustomViewHidden();
        fullScreenCallback = null;
    }

    private final class EditorChrome extends WebChromeClient {
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                  FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            // Document access requires no broad storage permission, including Android 13+.
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = Arrays.stream(params.getAcceptTypes())
                    .filter(type -> type.contains("/")).toArray(String[]::new);
            intent.setType(types.length == 1 ? types[0] : "*/*");
            if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try { filePicker.launch(Intent.createChooser(intent, getString(R.string.choose_file))); }
            catch (ActivityNotFoundException error) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
                toast(R.string.no_file_picker);
            }
            return true;
        }

        @Override public void onPermissionRequest(PermissionRequest request) {
            if (!BundledWeb.isLocal(request.getOrigin()) || !Arrays.asList(request.getResources())
                    .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else if (audioRequest == null) {
                audioRequest = request;
                audioPermission.launch(Manifest.permission.RECORD_AUDIO);
            } else request.deny();
        }

        @Override public void onPermissionRequestCanceled(PermissionRequest request) {
            if (audioRequest == request) audioRequest = null;
        }

        @Override public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullScreen != null) { callback.onCustomViewHidden(); return; }
            fullScreen = view;
            fullScreenCallback = callback;
            webView.setVisibility(View.GONE);
            root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        }

        @Override public void onHideCustomView() { hideFullScreen(); }

        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture,
                                                android.os.Message message) {
            // Receive target=_blank navigation in a temporary WebView and route
            // it to the system browser without loading an untrusted page here.
            if (!gesture) return false;
            WebView popup = new WebView(MainActivity.this);
            popup.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (BundledWeb.isLocal(uri)) webView.loadUrl(uri.toString());
                    else openExternal(uri);
                    popup.destroy();
                    return true;
                }
            });
            ((WebView.WebViewTransport) message.obj).setWebView(popup);
            message.sendToTarget();
            return true;
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        webView.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }

    @Override protected void onDestroy() {
        closing = true;
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (audioRequest != null) audioRequest.deny();
        downloads.execute(this::abortOutput);
        downloads.shutdown();
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
