(function() {
  var QUEUE_KEY = "azul_offline_queue_v1";
  var syncing = false;

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}));
    } catch (e) {
      return value || {};
    }
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function writeQueue(queue) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue || []));
    renderOfflineStatus();
  }

  function isNetworkError(error) {
    var msg = String(error && error.message ? error.message : error || "").toLowerCase();
    return navigator.onLine === false ||
      msg.indexOf("failed to fetch") >= 0 ||
      msg.indexOf("network") >= 0 ||
      msg.indexOf("load failed") >= 0 ||
      msg.indexOf("fetch") >= 0;
  }

  function getLabel(type) {
    var labels = {
      sale: "vente",
      purchase: "achat",
      expense: "depense",
      treasury: "tresorerie"
    };
    return labels[type] || type;
  }

  function ensureOfflineStatus() {
    var el = document.getElementById("azulOfflineStatus");
    if (el) return el;

    el = document.createElement("button");
    el.id = "azulOfflineStatus";
    el.type = "button";
    el.onclick = function() {
      window.azulSyncOfflineQueue(true);
    };
    document.body.appendChild(el);
    return el;
  }

  function renderOfflineStatus() {
    var el = ensureOfflineStatus();
    var queue = readQueue();
    var pending = queue.filter(function(item) {
      return item.status !== "done";
    }).length;

    el.className = "";

    if (navigator.onLine === false) {
      el.className = "offline";
      el.textContent = pending ? "Offline - " + pending + " en attente" : "Mode offline";
      el.style.display = "block";
      return;
    }

    if (pending) {
      el.className = "pending";
      el.textContent = pending + " element(s) a synchroniser";
      el.style.display = "block";
      return;
    }

    el.style.display = "none";
  }

  async function runQueuedOperation(item) {
    if (item.type === "sale") {
      return saveSaleToSupabase(item.payload);
    }

    if (item.type === "purchase") {
      return savePurchaseToSupabase(item.payload);
    }

    if (item.type === "expense") {
      var expense = await saveExpenseToSupabase(item.payload);
      await createAccountingEntry(
        "expense",
        expense.id,
        expense.expense_date,
        "Depense - " + expense.description,
        [
          { account: "62", debit: Number(expense.amount) || 0, credit: 0 },
          { account: "11", debit: 0, credit: Number(expense.amount) || 0 }
        ]
      );
      return expense;
    }

    if (item.type === "treasury") {
      return saveTreasuryManualEntryToSupabase(item.payload);
    }

    throw new Error("Type offline inconnu: " + item.type);
  }

  window.azulIsOfflineError = isNetworkError;

  window.azulQueueOfflineOperation = function(type, payload) {
    var queue = readQueue();
    var item = {
      id: "offline-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      type: type,
      label: getLabel(type),
      payload: clone(payload),
      status: "pending",
      attempts: 0,
      error: "",
      createdAt: new Date().toISOString()
    };

    queue.push(item);
    writeQueue(queue);
    renderOfflineStatus();

    return item;
  };

  window.azulGetOfflineQueue = readQueue;

  window.azulClearOfflineQueue = function() {
    writeQueue([]);
  };

  window.azulSyncOfflineQueue = async function(showToast) {
    if (syncing || navigator.onLine === false) {
      renderOfflineStatus();
      return;
    }

    var queue = readQueue();
    var pending = queue.filter(function(item) {
      return item.status !== "done";
    });

    if (!pending.length) {
      renderOfflineStatus();
      return;
    }

    syncing = true;
    renderOfflineStatus();

    try {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].status === "done") continue;

        queue[i].status = "syncing";
        queue[i].attempts = (queue[i].attempts || 0) + 1;
        writeQueue(queue);

        try {
          await runQueuedOperation(queue[i]);
          queue[i].status = "done";
          queue[i].error = "";
          writeQueue(queue);
        } catch (e) {
          queue[i].status = "pending";
          queue[i].error = e && e.message ? e.message : String(e || "");
          writeQueue(queue);

          if (isNetworkError(e)) break;
          console.error("Erreur sync offline:", e);
        }
      }

      queue = readQueue().filter(function(item) {
        return item.status !== "done";
      });
      writeQueue(queue);

      if (showToast && !queue.length && typeof toast === "function") {
        toast("Synchronisation offline terminee.", "success");
      }

      if (typeof loadDashboard === "function") loadDashboard();
      if (typeof loadProducts === "function") loadProducts(true);

    } finally {
      syncing = false;
      renderOfflineStatus();
    }
  };

  window.addEventListener("online", function() {
    renderOfflineStatus();
    window.azulSyncOfflineQueue(false);
  });

  window.addEventListener("offline", renderOfflineStatus);
  window.addEventListener("load", function() {
    renderOfflineStatus();
    window.azulSyncOfflineQueue(false);
  });
})();
