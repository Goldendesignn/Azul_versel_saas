var scannerSessionId = "";
var scannerSessionToken = "";
var scannerStream = null;
var scannerFrame = null;
var scannerBusy = false;
var scannerLastCode = { code: "", at: 0 };
var scannerSentCount = 0;
var SCANNER_DUPLICATE_DELAY_MS = 2600;
var SCANNER_RESUME_DELAY_MS = 1600;

function getScannerParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function normalizeScannerCode(value) {
  return String(value || "").trim();
}

function setScannerStatus(message, type) {
  var status = document.getElementById("scannerStatus");
  var pill = document.getElementById("scannerConnectionPill");

  if (status) {
    status.textContent = message || "";
    status.classList.toggle("error", type === "error");
  }

  if (pill) {
    pill.textContent = type === "error" ? "Erro" : "Ligado";
    pill.classList.toggle("error", type === "error");
  }
}

function getScannerDeviceName() {
  var ua = String(navigator.userAgent || "");
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone";
  return "Telefone";
}

function addScannerHistory(code) {
  scannerSentCount += 1;

  var counter = document.getElementById("scannerCount");
  var list = document.getElementById("scannerHistoryList");
  if (counter) counter.textContent = String(scannerSentCount);
  if (!list) return;

  var empty = list.querySelector(".scanner-empty");
  if (empty) empty.remove();

  var item = document.createElement("div");
  item.className = "scanner-history-item";
  item.innerHTML =
    "<strong>" + escapeScannerHtml(code) + "</strong>" +
    "<span>Enviado</span>";

  list.prepend(item);

  while (list.children.length > 8) {
    list.removeChild(list.lastElementChild);
  }
}

function escapeScannerHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function validateScannerSession() {
  if (!scannerSessionId || !scannerSessionToken) {
    setScannerStatus("Sessao invalida. Volta ao computador e cria um novo QR code.", "error");
    return false;
  }

  try {
    var result = await supabaseClient.rpc("validate_pos_scan_session", {
      p_session_id: scannerSessionId,
      p_session_token: scannerSessionToken
    });

    if (result.error) throw result.error;

    var data = Array.isArray(result.data) ? result.data[0] : null;
    if (!data || !data.ok) {
      setScannerStatus(data && data.message ? data.message : "Sessao expirada.", "error");
      return false;
    }

    setScannerStatus("Telefone ligado. Aponte para o codigo de barras.", "");
    return true;
  } catch (e) {
    console.error("Erro validacao scanner:", e);
    setScannerStatus("Nao foi possivel validar a sessao. Executa SQL/pos_phone_scanner.sql no Supabase.", "error");
    return false;
  }
}

async function sendBarcodeToCashier(code) {
  code = normalizeScannerCode(code);
  if (!code || scannerBusy) return false;

  scannerBusy = true;
  setScannerStatus("A enviar codigo " + code + " para a caixa...", "");

  try {
    var result = await supabaseClient
      .from("pos_scan_events")
      .insert({
        session_id: scannerSessionId,
        session_token: scannerSessionToken,
        barcode: code,
        device_name: getScannerDeviceName(),
        status: "pending"
      });

    if (result.error) throw result.error;

    addScannerHistory(code);
    setScannerStatus("Codigo enviado. Pode ler o proximo produto.", "");
    return true;
  } catch (e) {
    console.error("Erro envio scanner:", e);
    setScannerStatus("Erro ao enviar codigo. Verifica a sessao no computador.", "error");
    return false;
  } finally {
    setTimeout(function() {
      scannerBusy = false;
    }, SCANNER_RESUME_DELAY_MS);
  }
}

function sendManualBarcode(event) {
  if (event) event.preventDefault();
  var input = document.getElementById("manualBarcodeInput");
  var code = normalizeScannerCode(input ? input.value : "");
  if (!code) return;

  sendBarcodeToCashier(code).then(function(sent) {
    if (sent && input) {
      input.value = "";
      input.blur();
    }
  });
}

async function getScannerDetector() {
  if (!("BarcodeDetector" in window)) return null;

  var preferred = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "qr_code"];

  try {
    if (typeof BarcodeDetector.getSupportedFormats === "function") {
      var supported = await BarcodeDetector.getSupportedFormats();
      var formats = preferred.filter(function(format) {
        return supported.indexOf(format) >= 0;
      });
      return formats.length ? new BarcodeDetector({ formats: formats }) : new BarcodeDetector();
    }
  } catch (e) {
    console.warn("Formats scanner indisponiveis:", e);
  }

  return new BarcodeDetector();
}

async function startScannerCamera() {
  var video = document.getElementById("scannerVideo");
  if (!video) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScannerStatus("Camera indisponivel. Usa o campo manual.", "error");
    return;
  }

  var detector = await getScannerDetector();
  if (!detector) {
    setScannerStatus("Este navegador nao suporta leitura automatica. Usa o campo manual.", "error");
    return;
  }

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    video.srcObject = scannerStream;
    await video.play();
    scannerBusy = false;
    scanScannerFrame(detector, video);
  } catch (e) {
    console.error("Erro camera scanner:", e);
    setScannerStatus("Nao foi possivel abrir a camera. Usa o campo manual.", "error");
  }
}

async function scanScannerFrame(detector, video) {
  if (!scannerStream || !video || !detector) return;

  if (!scannerBusy) {
    try {
      var codes = await detector.detect(video);
      if (codes && codes.length) {
        var code = normalizeScannerCode(codes[0].rawValue || codes[0].rawValueText || "");
        var now = Date.now();

        if (code && !(scannerLastCode.code === code && now - scannerLastCode.at < SCANNER_DUPLICATE_DELAY_MS)) {
          scannerLastCode = { code: code, at: now };
          await sendBarcodeToCashier(code);
        }
      }
    } catch (e) {
      console.warn("Erro durante leitura:", e);
    }
  }

  scannerFrame = window.requestAnimationFrame(function() {
    scanScannerFrame(detector, video);
  });
}

function stopScannerCamera() {
  if (scannerFrame) {
    window.cancelAnimationFrame(scannerFrame);
    scannerFrame = null;
  }

  if (scannerStream) {
    scannerStream.getTracks().forEach(function(track) {
      track.stop();
    });
    scannerStream = null;
  }
}

async function initPhoneScannerPage() {
  scannerSessionId = getScannerParam("session");
  scannerSessionToken = getScannerParam("token");

  var isValid = await validateScannerSession();
  if (!isValid) return;

  await startScannerCamera();
}

window.addEventListener("beforeunload", stopScannerCamera);
document.addEventListener("DOMContentLoaded", initPhoneScannerPage);
