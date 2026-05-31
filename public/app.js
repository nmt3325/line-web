(function () {
  var socket = io();

  var myMid = null;
  var selectedChat = null; // { mid, name, avatarUrl, isGroup }
  var friends = [];
  var groups = [];
  var messageCache = {};
  // mid -> { id, createdTime } of the oldest loaded message (for pagination)
  var oldestMessageCache = {};
  // mid -> bool — whether more messages may exist before the oldest loaded
  var hasMoreMessages = {};
  // prevents concurrent loadMore calls
  var isLoadingMore = false;
  // mid -> { mid, name } for group sender display
  var contactCache = {};
  // chatMid -> { chatId, readers: { readerMid: lastReadMessageId }, ... }
  var readStatusCache = {};
  // chatMid -> [ { mid, name, avatarUrl } ]
  var groupMembersCache = {};
  var DEFAULT_AVATAR = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  var isLegacyIOS6Browser = detectLegacyIOS6Browser();

  // --- 複数アカウント ---
  var accounts = [];          // [{ id, mid, name, avatarUrl, connected }]
  var activeAccountId = null; // 現在表示中のアカウントID
  var accountUnread = {};     // accountId -> 非アクティブ時の新着件数（切替バー用バッジ）
  var loginAddMode = false;   // ログイン画面が「アカウント追加」モードか

  var loginScreen = document.getElementById("login-screen");
  var chatScreen = document.getElementById("chat-screen");
  var loginStatus = document.getElementById("login-status");
  var pincodeBox = document.getElementById("pincode-box");
  var pincodeDisplay = document.getElementById("pincode-display");

  var passwordForm = document.getElementById("password-form");
  var loginBtn = document.getElementById("login-btn");
  var emailInput = document.getElementById("email");
  var passwordInput = document.getElementById("password");

  var qrStartBtn = document.getElementById("qr-start-btn");
  var qrContainer = document.getElementById("qr-container");

  var friendList = document.getElementById("friend-list");
  var friendSearch = document.getElementById("friend-search");
  var groupList = document.getElementById("group-list");
  var groupSearch = document.getElementById("group-search");
  var logoutBtn = document.getElementById("logout-btn");
  var fullscreenBtn = document.getElementById("fullscreen-btn");
  var accountList = document.getElementById("account-list");
  var addAccountBtn = document.getElementById("add-account-btn");
  var loginBackBtn = document.getElementById("login-back-btn");

  var chatArea = document.getElementById("chat-area");
  var chatPlaceholder = document.getElementById("chat-placeholder");
  var chatPanel = document.getElementById("chat-panel");
  var backToFriendsBtn = document.getElementById("back-to-friends");
  var chatAvatar = document.getElementById("chat-avatar");
  var chatName = document.getElementById("chat-name");
  var messagesContainer = document.getElementById("messages-container");
  var messageListEl = document.getElementById("message-list");
  var sendForm = document.getElementById("send-form");
  var messageInput = document.getElementById("message-input");
  var sendBtn = document.getElementById("send-btn");
  var imageAttachBtn = document.getElementById("image-attach-btn");
  var imageInput = document.getElementById("image-input");
  var videoAttachBtn = document.getElementById("video-attach-btn");
  var videoInput = document.getElementById("video-input");
  var fileAttachBtn = document.getElementById("file-attach-btn");
  var fileInput = document.getElementById("file-input");
  var chatSubtitle = document.getElementById("chat-subtitle");
  var scrollBottomBtn = document.getElementById("scroll-bottom-btn");
  var uploadProgressEl = document.getElementById("upload-progress");
  var uploadProgressBar = document.getElementById("upload-progress-bar");
  var uploadProgressLabel = document.getElementById("upload-progress-label");

  // 入力中インジケータの自動消去タイマー（chatMid -> timeoutId）
  var typingTimers = {};
  // Push購読が有効なら、アプリ内のOS通知は抑制して二重通知を防ぐ
  var pushActive = false;

  setupAppFrame();
  setupLoginTabs();
  setupSidebarTabs();
  bindEvents();
  bindViewportEvents();
  bindSocketEvents();
  socket.emit("accounts:list");
  registerServiceWorker();

  function setupLoginTabs() {
    var tabs = document.querySelectorAll(".tab");
    var i;
    for (i = 0; i < tabs.length; i += 1) {
      bindLoginTab(tabs[i]);
    }
  }

  function bindLoginTab(tab) {
    tab.onclick = function () {
      var tabs = document.querySelectorAll(".tab");
      var contents = document.querySelectorAll(".tab-content");
      var i;
      var tabName = tab.getAttribute("data-tab");
      var target;

      for (i = 0; i < tabs.length; i += 1) {
        removeClass(tabs[i], "active");
      }
      for (i = 0; i < contents.length; i += 1) {
        removeClass(contents[i], "active");
      }

      addClass(tab, "active");
      target = document.getElementById("tab-" + tabName);
      if (target) {
        addClass(target, "active");
      }

      addClass(pincodeBox, "hidden");
      setStatus("", "");
    };
  }

  function setupSidebarTabs() {
    var tabs = document.querySelectorAll(".sidebar-tab");
    var i;
    for (i = 0; i < tabs.length; i += 1) {
      bindSidebarTab(tabs[i]);
    }
  }

  function bindSidebarTab(tab) {
    tab.onclick = function () {
      var tabs = document.querySelectorAll(".sidebar-tab");
      var contents = document.querySelectorAll(".sidebar-tab-content");
      var tabName = tab.getAttribute("data-sidebar-tab");
      var i;

      for (i = 0; i < tabs.length; i += 1) {
        removeClass(tabs[i], "active");
      }
      for (i = 0; i < contents.length; i += 1) {
        removeClass(contents[i], "active");
      }

      addClass(tab, "active");
      var target = document.getElementById("sidebar-" + tabName);
      if (target) {
        addClass(target, "active");
      }
    };
  }

  function bindEvents() {
    passwordForm.onsubmit = onPasswordSubmit;
    qrStartBtn.onclick = onQrStart;
    logoutBtn.onclick = onLogout;
    if (addAccountBtn) addAccountBtn.onclick = onAddAccount;
    if (loginBackBtn) loginBackBtn.onclick = onLoginBack;
    if (fullscreenBtn) fullscreenBtn.onclick = onToggleFullscreen;
    backToFriendsBtn.onclick = onBackToFriends;
    friendSearch.onkeyup = onFriendSearch;
    friendSearch.oninput = onFriendSearch;
    groupSearch.onkeyup = onGroupSearch;
    groupSearch.oninput = onGroupSearch;
    sendForm.onsubmit = onSendSubmit;
    messageInput.oninput = adjustTextarea;
    messageInput.onkeyup = adjustTextarea;
    messageInput.onkeydown = onMessageKeyDown;
    messageInput.onfocus = onMessageInputFocus;
    messageInput.onpaste = onMessageInputPaste;
    if (chatArea) {
      chatArea.ondragover = onChatAreaDragOver;
      chatArea.ondrop = onChatAreaDrop;
      chatArea.ondragleave = onChatAreaDragLeave;
    }
    if (imageAttachBtn) {
      imageAttachBtn.onclick = onImageAttachClick;
      imageAttachBtn.onkeydown = onComposeControlKeyDown;
    }
    if (videoAttachBtn) {
      videoAttachBtn.onclick = onVideoAttachClick;
      videoAttachBtn.onkeydown = onComposeControlKeyDown;
    }
    sendBtn.onkeydown = onComposeControlKeyDown;
    if (fileAttachBtn) {
      fileAttachBtn.onclick = onFileAttachClick;
      fileAttachBtn.onkeydown = onComposeControlKeyDown;
    }
    if (imageInput) imageInput.onchange = onImageSelected;
    if (videoInput) videoInput.onchange = onVideoSelected;
    if (fileInput) fileInput.onchange = onFileSelected;
    if (replyCancelBtn) replyCancelBtn.onclick = cancelReply;
    if (scrollBottomBtn) scrollBottomBtn.onclick = function () { scrollToBottomWithRetry(); hideScrollBottomBtn(); };
    if (messagesContainer) {
      messagesContainer.onscroll = onMessagesScroll;
    }
  }

  function onMessagesScroll() {
    if (!selectedChat) return;
    var mid = String(selectedChat.mid);
    // 最新へ戻るボタンの表示制御
    if (isNearBottom()) {
      hideScrollBottomBtn();
    } else {
      showScrollBottomBtn();
    }
    if (!hasMoreMessages[mid]) return;
    if (isLoadingMore) return;
    // 上端に近づいたら古いメッセージを読み込む（100px以内）
    if (messagesContainer.scrollTop <= 100) {
      loadMoreMessages(mid);
    }
  }

  function isNearBottom() {
    var c = messagesContainer;
    if (!c) return true;
    return (c.scrollHeight - c.scrollTop - c.clientHeight) < 140;
  }

  function showScrollBottomBtn() {
    if (scrollBottomBtn) removeClass(scrollBottomBtn, "hidden");
  }

  function hideScrollBottomBtn() {
    if (scrollBottomBtn) {
      addClass(scrollBottomBtn, "hidden");
      scrollBottomBtn.removeAttribute("data-unread");
    }
  }

  function bindViewportEvents() {
    if (window.addEventListener) {
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("focus", onWindowFocus);
    }
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener("resize", onViewportChange);
      window.visualViewport.addEventListener("scroll", onViewportChange);
    }
  }

  function onViewportChange() {
    if (!selectedChat || !selectedChat.mid) return;
    if (document.activeElement !== messageInput) return;
    scrollToBottomWithRetry();
  }

  // ウィンドウにフォーカスが戻ったら、開いているチャットを既読にする
  function onWindowFocus() {
    if (!selectedChat || !selectedChat.mid) return;
    var mid = String(selectedChat.mid);
    clearUnread(mid);
    sendReadReceipt(mid);
  }

  function bindSocketEvents() {
    socket.on("accounts:update", function (data) {
      handleAccountsUpdate(data);
    });

    socket.on("auth:none", function () {
      setLoginBusy(false);
      accounts = [];
      activeAccountId = null;
      renderAccountBar();
      closeChatForMobile();
      setAddMode(false);
      showScreen("login");
    });

    socket.on("auth:success", function (payload) {
      setLoginBusy(false);
      setAddMode(false);
      var id = payload && payload.account ? payload.account.id : null;
      if (id) {
        // accounts:update が先に届いて accounts に反映済みのはず。新アカウントへ切替。
        activeAccountId = null;
        switchAccount(id, true);
      }
    });

    socket.on("auth:pincode", function (payload) {
      removeClass(pincodeBox, "hidden");
      pincodeDisplay.textContent = payload && payload.pincode ? payload.pincode : "";
      setStatus("LINEアプリでPINコードを確認してください", "info");
    });

    socket.on("auth:qrcode", function (payload) {
      clearNode(qrContainer);
      if (payload && payload.dataUrl) {
        var img = document.createElement("img");
        img.src = payload.dataUrl;
        img.alt = "QR Code";
        img.width = 200;
        qrContainer.appendChild(img);
      }
      setStatus("スマートフォンのLINEアプリでQRコードをスキャンしてください", "info");
      setLoginBusy(false);
    });

    socket.on("auth:error", function (payload) {
      var message = payload && payload.error ? payload.error : "ログインエラー";
      setStatus(message, "error");
      setLoginBusy(false);
      addClass(pincodeBox, "hidden");
    });

    socket.on("chat:read", function (data) {
      if (!data || !data.chatMid) return;
      if (!isActiveAccountEvent(data)) return;
      var chatMid = String(data.chatMid);
      var readerMid = data.readerMid ? String(data.readerMid) : "";

      // 既読情報が来たら該当チャットの表示を更新
      if (selectedChat && String(selectedChat.mid) === chatMid) {
        // 簡易的にAPIを再取得して正確な既読範囲を取得
        fetchReadStatus(chatMid, function () {
          renderMessages(chatMid);
        });
      }
    });

    socket.on("chat:unsend", function (data) {
      if (!data || !data.messageId) return;
      if (!isActiveAccountEvent(data)) return;
      var msgId = String(data.messageId);
      // キャッシュ内のメッセージを取り消し済みに更新
      Object.keys(messageCache).forEach(function (chatMid) {
        messageCache[chatMid] = messageCache[chatMid].map(function (m) {
          if (String(m.id) !== msgId) return m;
          return { id: m.id, from: m.from, to: m.to, text: "", contentType: m.contentType, contentMetadata: { UNSENT: "true" }, location: null, createdTime: m.createdTime };
        });
      });
      // DOMの該当バブルを「取り消されました」表示に差し替え
      var el = messageListEl.querySelector('[data-id="' + msgId + '"]');
      if (el) {
        var bubble = el.querySelector(".msg-bubble");
        if (bubble) {
          bubble.className = "msg-bubble msg-unsent-notice";
          while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
          bubble.textContent = "メッセージが取り消されました";
        }
      }
      hideUnsendMenu();
    });

    socket.on("chat:message", function (msg) {
      if (!msg) return;

      // 表示中でないアカウント宛の新着は、切替バーのバッジ更新＋通知のみ行う
      if (!isActiveAccountEvent(msg)) {
        handleBackgroundMessage(msg);
        return;
      }

      var fromStr = msg.from ? String(msg.from) : "";
      var toStr = msg.to ? String(msg.to) : "";
      var isOutgoing = myMid && fromStr && fromStr === String(myMid);
      var isSystem = msg.system === true || isSystemMessage(msg);

      // システムメッセージ以外で、自分が送信したものは sendCurrentMessage() で追加済みのためスキップ
      if (isOutgoing && !isSystem) return;

      // チャットの所属を判定
      var chatMid;
      if (toStr && toStr.charAt(0) === "c") {
        chatMid = toStr; // グループ/チャット
      } else if (isSystem) {
        chatMid = toStr || fromStr;
      } else {
        // 1:1: myMid未取得時は方向不明のためスキップ（再接続後に取得済みになる）
        if (!myMid) return;
        chatMid = isOutgoing ? toStr : fromStr;
      }
      if (!chatMid) return;

      var added = cacheMessage(chatMid, msg);
      updateChatLastMessageTime(chatMid, msg.createdTime);

      var isActive = selectedChat && String(selectedChat.mid) === chatMid;
      var focused = document.hasFocus();

      // チャット一覧のプレビュー・未読バッジを更新
      if (!isSystem && !isOutgoing && (!isActive || !focused)) {
        bumpUnread(chatMid, msg);
      } else {
        setChatPreview(chatMid, getMessagePreviewText(msg));
      }

      // OS通知（Push未購読時のみ・自分の送信/システム以外）
      if (!pushActive && !isSystem && !isOutgoing && (!focused || !isActive)) {
        showNewMessageNotification(chatMid, msg);
      }

      if (isActive) {
        if (added) appendIncomingMessage(chatMid, msg);
        // 表示中かつフォーカスありなら既読を送る
        if (focused && !isOutgoing && !isSystem) {
          clearUnread(chatMid);
          sendReadReceipt(chatMid);
        }
      }
    });

    socket.on("chat:typing", function (data) {
      if (!data || !data.chatMid) return;
      if (!isActiveAccountEvent(data)) return;
      var chatMid = String(data.chatMid);
      if (!selectedChat || String(selectedChat.mid) !== chatMid) return;
      var name = getSenderName(data.mid);
      showTyping(chatMid, name);
    });

    socket.on("chat:message-edited", function (msg) {
      if (!msg || !msg.id) return;
      if (!isActiveAccountEvent(msg)) return;
      var msgId = String(msg.id);
      var toStr = msg.to ? String(msg.to) : "";
      var fromStr = msg.from ? String(msg.from) : "";
      var chatMid = (toStr && toStr.charAt(0) === "c") ? toStr
        : (myMid && fromStr === String(myMid) ? toStr : fromStr);
      if (!chatMid) return;
      // キャッシュ更新
      var arr = messageCache[chatMid] || [];
      for (var i = 0; i < arr.length; i += 1) {
        if (arr[i] && String(arr[i].id) === msgId) { msg.edited = true; arr[i] = msg; break; }
      }
      // DOM更新
      if (selectedChat && String(selectedChat.mid) === chatMid) {
        var el = messageListEl.querySelector('[data-id="' + msgId + '"]');
        var bubble = el && el.querySelector(".msg-bubble");
        if (bubble) {
          while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
          if (msg.text) renderTextWithLinks(bubble, String(msg.text));
          var editedTag = document.createElement("span");
          editedTag.className = "msg-edited-tag";
          editedTag.textContent = " (編集済み)";
          bubble.appendChild(editedTag);
        }
      }
      setChatPreview(chatMid, getMessagePreviewText(msg));
    });

    socket.on("chat:reaction", function (data) {
      if (!data || !data.messageId) return;
      if (!isActiveAccountEvent(data)) return;
      // ベストエフォート: 該当メッセージが表示中なら小さなリアクション表示を付与
      if (!selectedChat) return;
      var el = messageListEl.querySelector('[data-id="' + String(data.messageId) + '"]');
      if (!el) return;
      var existing = el.querySelector(".msg-reaction");
      if (!existing) {
        existing = document.createElement("div");
        existing.className = "msg-reaction";
        el.appendChild(existing);
      }
      existing.textContent = reactionEmoji(data.reactionType);
    });
  }

  function reactionEmoji(type) {
    var map = { "2": "❤️", "3": "👍", "4": "😆", "5": "😲", "6": "😢", "7": "😡" };
    return map[String(type)] || "👍";
  }

  // --- 複数アカウント ---

  // イベントが現在表示中のアカウント宛か判定（accountId 無しのレガシーは許可）
  function isActiveAccountEvent(data) {
    if (!data || !data.accountId) return true;
    return String(data.accountId) === String(activeAccountId);
  }

  function findAccount(id) {
    if (!id) return null;
    for (var i = 0; i < accounts.length; i += 1) {
      if (accounts[i] && String(accounts[i].id) === String(id)) return accounts[i];
    }
    return null;
  }

  var loadedAccountId = null; // 友達/グループを読み込み済みのアカウント

  function handleAccountsUpdate(data) {
    accounts = (data && data.accounts) ? data.accounts : [];

    if (accounts.length === 0) {
      activeAccountId = null;
      loadedAccountId = null;
      renderAccountBar();
      setAddMode(false);
      showScreen("login");
      return;
    }

    // ログイン追加モード中はアカウント一覧の更新だけ反映し、画面遷移はしない
    if (loginAddMode) {
      renderAccountBar();
      return;
    }

    // アクティブ未設定/無効なら、保存済み or 最初の接続済みアカウントを選ぶ
    if (!activeAccountId || !findAccount(activeAccountId)) {
      var saved = null;
      try { saved = localStorage.getItem("activeAccountId"); } catch (e) {}
      var chosen = (saved && findAccount(saved)) ? saved : null;
      if (!chosen) {
        var connected = accounts.filter(function (a) { return a.connected; });
        chosen = (connected[0] || accounts[0]).id;
      }
      switchAccount(chosen, true);
      return;
    }

    renderAccountBar();
    maybeLoadActiveAccount();
  }

  function switchAccount(id, isInitial) {
    var acct = findAccount(id);
    if (!acct) return;
    if (!isInitial && String(activeAccountId) === String(id)) return;
    activeAccountId = String(id);
    try { localStorage.setItem("activeAccountId", activeAccountId); } catch (e) {}
    accountUnread[activeAccountId] = 0;
    loadedAccountId = null;
    resetChatState();
    renderAccountBar();
    showScreen("chat");
    closeChatForMobile();
    maybeLoadActiveAccount();
  }

  // アクティブアカウントが接続済みなら友達/グループを読み込む。
  // 復元中（未接続）なら接続完了時に accounts:update から再度呼ばれる。
  function maybeLoadActiveAccount() {
    var acct = findAccount(activeAccountId);
    if (!acct) return;
    if (!acct.connected) {
      setListMessage(friendList, "アカウントに接続中...", false);
      setListMessage(groupList, "アカウントに接続中...", false);
      return;
    }
    if (loadedAccountId === activeAccountId) return;
    loadedAccountId = activeAccountId;
    fetchProfile();
    loadFriends();
    loadGroups();
    ensureNotificationPermission(registerPush);
  }

  function resetChatState() {
    selectedChat = null;
    myMid = null;
    friends = [];
    groups = [];
    messageCache = {};
    oldestMessageCache = {};
    hasMoreMessages = {};
    contactCache = {};
    readStatusCache = {};
    groupMembersCache = {};
    if (messageListEl) clearNode(messageListEl);
    if (friendList) clearNode(friendList);
    if (groupList) clearNode(groupList);
    if (chatPanel) addClass(chatPanel, "hidden");
    if (chatPlaceholder) removeClass(chatPlaceholder, "hidden");
    hideScrollBottomBtn();
  }

  function renderAccountBar() {
    if (!accountList) return;
    clearNode(accountList);
    for (var i = 0; i < accounts.length; i += 1) {
      accountList.appendChild(buildAccountItem(accounts[i]));
    }
  }

  function buildAccountItem(acct) {
    var li = document.createElement("li");
    li.className = "account-item";
    if (String(acct.id) === String(activeAccountId)) addClass(li, "active");
    if (!acct.connected) addClass(li, "offline");
    li.setAttribute("data-account-id", acct.id);
    li.title = (acct.name || acct.mid || "アカウント") + (acct.connected ? "" : "（接続中）");

    var img = document.createElement("img");
    img.className = "account-avatar";
    img.src = acct.avatarUrl || DEFAULT_AVATAR;
    img.alt = acct.name || "";
    img.onerror = function () { this.src = DEFAULT_AVATAR; };
    li.appendChild(img);

    var name = document.createElement("span");
    name.className = "account-name";
    name.textContent = acct.name || acct.mid || "(未取得)";
    li.appendChild(name);

    var unread = Number(accountUnread[acct.id]) || 0;
    if (unread > 0 && String(acct.id) !== String(activeAccountId)) {
      var badge = document.createElement("span");
      badge.className = "account-unread";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      li.appendChild(badge);
    }

    li.onclick = function () { switchAccount(acct.id, false); };
    return li;
  }

  // 表示中でないアカウント宛の新着: 切替バーのバッジを増やす（OS通知はサーバーのPWA Pushに任せる）
  function handleBackgroundMessage(msg) {
    var acctId = msg.accountId ? String(msg.accountId) : "";
    if (!acctId) return;
    if (msg.system === true || isSystemMessage(msg)) return;
    var acct = findAccount(acctId);
    var fromStr = msg.from ? String(msg.from) : "";
    if (acct && acct.mid && fromStr === String(acct.mid)) return; // 自分の送信は数えない
    accountUnread[acctId] = (Number(accountUnread[acctId]) || 0) + 1;
    renderAccountBar();
  }

  function onAddAccount() {
    setAddMode(true);
    showScreen("login");
  }

  function onLoginBack() {
    setAddMode(false);
    if (activeAccountId && findAccount(activeAccountId)) {
      showScreen("chat");
    }
  }

  // ログイン画面を「アカウント追加」モードに切り替える（戻るボタンの表示など）
  function setAddMode(on) {
    loginAddMode = !!on;
    if (loginBackBtn) {
      if (loginAddMode && accounts.length > 0) removeClass(loginBackBtn, "hidden");
      else addClass(loginBackBtn, "hidden");
    }
    setStatus("", "");
    addClass(pincodeBox, "hidden");
    if (qrContainer) {
      clearNode(qrContainer);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-primary";
      btn.id = "qr-start-btn";
      btn.textContent = "QRコードを表示";
      btn.onclick = onQrStart;
      qrContainer.appendChild(btn);
      qrStartBtn = btn;
    }
  }

  function fetchProfile() {
    apiRequest("GET", "/api/profile", null, function (status, data) {
      if (status >= 200 && status < 300 && data && data.mid) {
        myMid = data.mid;
      }
    });
  }

  function onPasswordSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    var email = trim(emailInput.value);
    var password = passwordInput.value || "";
    if (!email || !password) return false;
    setLoginBusy(true);
    setStatus("認証中...", "info");
    socket.emit("auth:password", { email: email, password: password });
    return false;
  }

  function onQrStart() {
    clearNode(qrContainer);
    qrContainer.appendChild(createInfoNode("QRコードを生成中..."));
    setLoginBusy(true);
    setStatus("", "");
    socket.emit("auth:qr");
  }

  function onLogout() {
    var acct = findAccount(activeAccountId);
    var label = acct && (acct.name || acct.mid) ? "「" + (acct.name || acct.mid) + "」" : "このアカウント";
    if (!window.confirm(label + "からログアウトしますか？")) return;
    apiRequest("POST", "/api/auth/logout", null, function () {
      // ログアウトしたアカウントを忘れ、残りのアカウント or ログイン画面へ
      try { localStorage.removeItem("activeAccountId"); } catch (e) {}
      window.location.reload();
    });
  }

  function onBackToFriends() {
    closeChatForMobile();
  }

  // --- Friends ---

  function loadFriends() {
    setListMessage(friendList, "読み込み中...", false);
    apiRequest("GET", "/api/friends", null, function (status, data) {
      if (status < 200 || status >= 300) {
        setListMessage(friendList, data && data.error ? data.error : "友達一覧の取得に失敗しました", true);
        return;
      }
      friends = sortChatsByLastMessageTime(data && data.friends ? data.friends : []);
      // キャッシュに登録
      for (var i = 0; i < friends.length; i += 1) {
        if (friends[i] && friends[i].mid) {
          contactCache[String(friends[i].mid)] = { mid: friends[i].mid, name: friends[i].name || friends[i].mid };
        }
      }
      renderFriendList(getFilteredFriends());
    });
  }

  function renderFriendList(list) {
    clearNode(friendList);
    if (!list || list.length === 0) {
      setListMessage(friendList, "友達が見つかりません", false);
      return;
    }
    for (var i = 0; i < list.length; i += 1) {
      renderFriendItem(list[i]);
    }
  }

  function renderFriendItem(friend) {
    var sub = friend && friend.preview ? String(friend.preview)
      : (friend && friend.statusMessage ? String(friend.statusMessage) : "");
    var li = buildChatListItem(friend, sub, false);
    friendList.appendChild(li);
  }

  // チャット一覧アイテム共通ビルダー（友達・グループ）
  function buildChatListItem(chat, subText, isGroup) {
    var li = document.createElement("li");
    var img = document.createElement("img");
    var info = document.createElement("div");
    var topRow = document.createElement("div");
    var name = document.createElement("div");
    var time = document.createElement("div");
    var bottomRow = document.createElement("div");
    var sub = document.createElement("div");

    var mid = chat && chat.mid ? String(chat.mid) : "";
    li.className = "friend-item";
    li.setAttribute("data-mid", mid);
    li.onclick = function () {
      openChat({ mid: chat.mid, name: chat.name, avatarUrl: chat.avatarUrl, isGroup: isGroup });
    };

    img.className = "friend-avatar";
    img.alt = chat && chat.name ? String(chat.name) : "";
    img.src = chat && chat.avatarUrl ? String(chat.avatarUrl) : DEFAULT_AVATAR;
    img.onerror = function () { this.src = DEFAULT_AVATAR; };

    info.className = "friend-info";

    topRow.className = "friend-top-row";
    name.className = "friend-name";
    name.textContent = chat && chat.name ? String(chat.name) : "(no name)";
    time.className = "friend-time";
    time.textContent = chat && chat.lastMessageTime ? formatListTime(chat.lastMessageTime) : "";
    topRow.appendChild(name);
    topRow.appendChild(time);

    bottomRow.className = "friend-bottom-row";
    sub.className = "friend-status";
    sub.textContent = subText || "";
    bottomRow.appendChild(sub);

    var unread = Number(chat && chat.unreadCount) || 0;
    if (unread > 0) {
      var badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      bottomRow.appendChild(badge);
      addClass(li, "has-unread");
    }

    info.appendChild(topRow);
    info.appendChild(bottomRow);
    li.appendChild(img);
    li.appendChild(info);
    return li;
  }

  function formatListTime(ts) {
    var t = toTimestampMs(ts);
    if (!t) return "";
    var d = new Date(t);
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    var diffDays = Math.round((now.setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
    if (diffDays === 1) return "昨日";
    if (diffDays < 7) return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()] + "曜";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function onFriendSearch() {
    renderFriendList(getFilteredFriends());
  }

  // --- Groups ---

  function loadGroups() {
    setListMessage(groupList, "読み込み中...", false);
    apiRequest("GET", "/api/groups", null, function (status, data) {
      if (status < 200 || status >= 300) {
        setListMessage(groupList, data && data.error ? data.error : "グループ一覧の取得に失敗しました", true);
        return;
      }
      groups = sortChatsByLastMessageTime(data && data.groups ? data.groups : []);
      renderGroupList(getFilteredGroups());
    });
  }

  function renderGroupList(list) {
    clearNode(groupList);
    if (!list || list.length === 0) {
      setListMessage(groupList, "グループが見つかりません", false);
      return;
    }
    for (var i = 0; i < list.length; i += 1) {
      renderGroupItem(list[i]);
    }
  }

  function renderGroupItem(group) {
    var sub = group && group.preview ? String(group.preview)
      : (group && group.memberCount ? group.memberCount + "人" : "");
    var li = buildChatListItem(group, sub, true);
    groupList.appendChild(li);
  }

  function onGroupSearch() {
    renderGroupList(getFilteredGroups());
  }

  function getFilteredFriends() {
    var q = trim(friendSearch.value).toLowerCase();
    var filtered = [];
    for (var i = 0; i < friends.length; i += 1) {
      var n = friends[i] && friends[i].name ? String(friends[i].name).toLowerCase() : "";
      if (!q || n.indexOf(q) !== -1) filtered.push(friends[i]);
    }
    return filtered;
  }

  function getFilteredGroups() {
    var q = trim(groupSearch.value).toLowerCase();
    var filtered = [];
    for (var i = 0; i < groups.length; i += 1) {
      var n = groups[i] && groups[i].name ? String(groups[i].name).toLowerCase() : "";
      if (!q || n.indexOf(q) !== -1) filtered.push(groups[i]);
    }
    return filtered;
  }

  function toTimestampMs(value) {
    var parsed = Number(value);
    if (!isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  function sortChatsByLastMessageTime(list) {
    var sorted = (list || []).slice(0);
    sorted.sort(function (a, b) {
      var timeDiff = toTimestampMs(b && b.lastMessageTime) - toTimestampMs(a && a.lastMessageTime);
      if (timeDiff !== 0) return timeDiff;
      var nameA = a && a.name ? String(a.name) : "";
      var nameB = b && b.name ? String(b.name) : "";
      return nameA.localeCompare(nameB, "ja");
    });
    return sorted;
  }

  function sortMessagesByCreatedTime(list) {
    var sorted = (list || []).slice(0);
    sorted.sort(function (a, b) {
      var timeDiff = toTimestampMs(a && a.createdTime) - toTimestampMs(b && b.createdTime);
      if (timeDiff !== 0) return timeDiff;
      var idA = a && a.id ? String(a.id) : "";
      var idB = b && b.id ? String(b.id) : "";
      return idA.localeCompare(idB);
    });
    return sorted;
  }

  // メッセージをキャッシュに追加。既存IDなら置き換えて false、新規なら true を返す。
  function cacheMessage(chatMid, msg) {
    if (!messageCache[chatMid]) {
      messageCache[chatMid] = [];
    }
    var arr = messageCache[chatMid];
    for (var i = 0; i < arr.length; i += 1) {
      if (arr[i] && String(arr[i].id) === String(msg.id)) {
        arr[i] = msg;
        return false;
      }
    }
    arr.push(msg);
    messageCache[chatMid] = sortMessagesByCreatedTime(arr);
    return true;
  }

  function updateListLastMessageTime(list, mid, timestamp) {
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i] || String(list[i].mid) !== mid) continue;
      var currentTime = toTimestampMs(list[i].lastMessageTime);
      if (timestamp > currentTime) {
        list[i].lastMessageTime = timestamp;
        return true;
      }
      return false;
    }
    return false;
  }

  function updateChatLastMessageTime(mid, createdTime) {
    var chatMid = mid ? String(mid) : "";
    if (!chatMid) return;

    var timestamp = toTimestampMs(createdTime);
    if (!timestamp) timestamp = (new Date()).getTime();

    var friendChanged = updateListLastMessageTime(friends, chatMid, timestamp);
    var groupChanged = updateListLastMessageTime(groups, chatMid, timestamp);
    if (!friendChanged && !groupChanged) return;

    if (friendChanged) {
      friends = sortChatsByLastMessageTime(friends);
      renderFriendList(getFilteredFriends());
    }
    if (groupChanged) {
      groups = sortChatsByLastMessageTime(groups);
      renderGroupList(getFilteredGroups());
    }
    if (selectedChat && selectedChat.mid) {
      highlightActiveItem(String(selectedChat.mid));
    }
  }

  // --- 未読バッジ / プレビュー ---

  function findChatInLists(mid) {
    var i;
    for (i = 0; i < friends.length; i += 1) {
      if (friends[i] && String(friends[i].mid) === mid) return friends[i];
    }
    for (i = 0; i < groups.length; i += 1) {
      if (groups[i] && String(groups[i].mid) === mid) return groups[i];
    }
    return null;
  }

  function refreshChatItem(mid) {
    if (findChatInLists(mid)) {
      friends = sortChatsByLastMessageTime(friends);
      groups = sortChatsByLastMessageTime(groups);
      renderFriendList(getFilteredFriends());
      renderGroupList(getFilteredGroups());
      if (selectedChat && selectedChat.mid) highlightActiveItem(String(selectedChat.mid));
    }
  }

  function bumpUnread(mid, msg) {
    var chatMid = String(mid);
    var chat = findChatInLists(chatMid);
    if (!chat) return;
    chat.unreadCount = (Number(chat.unreadCount) || 0) + 1;
    chat.preview = getMessagePreviewText(msg);
    refreshChatItem(chatMid);
  }

  function clearUnread(mid) {
    var chatMid = String(mid);
    var chat = findChatInLists(chatMid);
    if (!chat || !chat.unreadCount) return;
    chat.unreadCount = 0;
    refreshChatItem(chatMid);
  }

  function setChatPreview(mid, text) {
    var chatMid = String(mid);
    var chat = findChatInLists(chatMid);
    if (!chat) return;
    chat.preview = text || "";
    refreshChatItem(chatMid);
  }

  // --- 既読送信 ---

  function sendReadReceipt(mid) {
    var chatMid = String(mid);
    var msgs = messageCache[chatMid] || [];
    var lastId = null;
    for (var i = msgs.length - 1; i >= 0; i -= 1) {
      // システムメッセージや楽観追加した一時IDは既読送信に使わない
      if (msgs[i] && msgs[i].id && String(msgs[i].id).indexOf("sys-") !== 0
          && /^[0-9]+$/.test(String(msgs[i].id))) {
        lastId = String(msgs[i].id);
        break;
      }
    }
    if (!lastId) return;
    apiRequest("POST", "/api/chat/" + encodeURIComponent(chatMid) + "/read",
      { lastMessageId: lastId }, function () {});
  }

  // --- 入力中インジケータ ---

  function showTyping(mid, name) {
    var chatMid = String(mid);
    if (!chatSubtitle) return;
    chatSubtitle.textContent = (name ? name : "相手") + "が入力中…";
    addClass(chatSubtitle, "typing");
    if (typingTimers[chatMid]) window.clearTimeout(typingTimers[chatMid]);
    typingTimers[chatMid] = window.setTimeout(function () {
      hideTyping(chatMid);
    }, 6000);
  }

  function hideTyping(mid) {
    var chatMid = String(mid);
    if (typingTimers[chatMid]) {
      window.clearTimeout(typingTimers[chatMid]);
      delete typingTimers[chatMid];
    }
    if (chatSubtitle && selectedChat && String(selectedChat.mid) === chatMid) {
      chatSubtitle.textContent = "";
      removeClass(chatSubtitle, "typing");
    }
  }

  // --- 新着メッセージの差分追加（全再描画を避けてちらつきを防ぐ） ---

  function appendIncomingMessage(mid, msg) {
    var chatMid = String(mid);
    // 既にDOMにある場合は重複追加しない
    if (messageListEl.querySelector('[data-id="' + String(msg.id) + '"]')) return;

    var isGroup = selectedChat && selectedChat.isGroup;
    var wasNearBottom = isNearBottom();

    // 「メッセージがありません」などのプレースホルダを除去
    var placeholder = messageListEl.querySelector("li.loading");
    if (placeholder) messageListEl.removeChild(placeholder);

    // 末尾の日付と異なる場合は日付区切りを挿入
    var msgDateStr = formatDateHeader(msg.createdTime);
    var lastDate = getLastDateStrInList();
    if (lastDate !== msgDateStr) {
      var divider = document.createElement("li");
      divider.className = "date-divider";
      var span = document.createElement("span");
      span.textContent = msgDateStr;
      divider.appendChild(span);
      messageListEl.appendChild(divider);
    }

    var li = buildMessageEl(msg, isGroup);
    if (li) messageListEl.appendChild(li);

    if (wasNearBottom) {
      scrollToBottomWithRetry();
    } else {
      showScrollBottomBtn();
      if (scrollBottomBtn) scrollBottomBtn.setAttribute("data-unread", "1");
    }
  }

  function getLastDateStrInList() {
    var items = messageListEl.querySelectorAll("li[data-time]");
    if (!items || items.length === 0) return null;
    var t = items[items.length - 1].getAttribute("data-time");
    if (!t) return null;
    return formatDateHeader(Number(t));
  }

  // --- Chat ---

  function openChat(chat) {
    var mid = chat && chat.mid ? String(chat.mid) : "";
    if (!mid) return;

    cancelReply();
    selectedChat = chat;
    highlightActiveItem(mid);

    chatAvatar.src = chat.avatarUrl ? String(chat.avatarUrl) : DEFAULT_AVATAR;
    chatAvatar.onerror = function () { this.src = DEFAULT_AVATAR; };
    chatName.textContent = chat.name ? String(chat.name) : "";

    addClass(chatPlaceholder, "hidden");
    removeClass(chatPanel, "hidden");
    openChatForMobile();

    setMessageListMessage("メッセージを読み込み中...", false);
    scrollToBottom();
    hideScrollBottomBtn();

    // 入力中表示・サブタイトルをリセット
    if (chatSubtitle) { chatSubtitle.textContent = ""; removeClass(chatSubtitle, "typing"); }
    hideTyping(mid);

    // 開いたチャットの未読をクリア
    clearUnread(mid);

    // チャット切り替え時にページネーション状態をリセット
    isLoadingMore = false;
    hasMoreMessages[mid] = false;
    oldestMessageCache[mid] = null;
    var indicator = document.getElementById("load-more-indicator");
    if (indicator) indicator.style.display = "none";

    loadMessages(mid);
  }

  function highlightActiveItem(mid) {
    var items = document.querySelectorAll(".friend-item");
    var i;
    for (i = 0; i < items.length; i += 1) {
      if (items[i].getAttribute("data-mid") === mid) {
        addClass(items[i], "active");
      } else {
        removeClass(items[i], "active");
      }
    }
  }

  function loadMessages(mid) {
    apiRequest("GET", "/api/chat/" + encodeURIComponent(mid) + "/messages?limit=100", null, function (status, data) {
      if (status < 200 || status >= 300) {
        setMessageListMessage(data && data.error ? data.error : "メッセージ取得に失敗しました", true);
        return;
      }
      var msgs = sortMessagesByCreatedTime(data && data.messages ? data.messages : []);
      messageCache[mid] = msgs;
      hasMoreMessages[mid] = !!(data && data.hasMore);
      oldestMessageCache[mid] = msgs.length > 0 ? msgs[0] : null;
      // 既読情報を取得してからメッセージを描画
      fetchReadStatus(mid, function () {
        renderMessages(mid);
        // 開いたチャットのメッセージを既読にする
        if (document.hasFocus()) sendReadReceipt(mid);
      });
      // グループチャットの場合はメンバー情報も取得
      if (selectedChat && selectedChat.isGroup && !groupMembersCache[mid]) {
        fetchGroupMembers(mid);
      }
    });
  }

  function loadMoreMessages(mid) {
    if (isLoadingMore) return;
    if (!hasMoreMessages[mid]) return;
    var oldest = oldestMessageCache[mid];
    if (!oldest) return;

    isLoadingMore = true;
    updateLoadMoreIndicator(mid, true);

    var url = "/api/chat/" + encodeURIComponent(mid) + "/messages?limit=100"
      + "&beforeMessageId=" + encodeURIComponent(oldest.id)
      + "&beforeDeliveredTime=" + encodeURIComponent(oldest.createdTime);

    apiRequest("GET", url, null, function (status, data) {
      isLoadingMore = false;
      if (!selectedChat || String(selectedChat.mid) !== String(mid)) return;

      if (status < 200 || status >= 300) {
        updateLoadMoreIndicator(mid, false);
        return;
      }

      var newMsgs = sortMessagesByCreatedTime(data && data.messages ? data.messages : []);
      hasMoreMessages[mid] = !!(data && data.hasMore);
      if (newMsgs.length > 0) {
        oldestMessageCache[mid] = newMsgs[0];
      } else {
        hasMoreMessages[mid] = false;
      }

      // スクロール位置を維持しながら先頭にメッセージを追加
      var container = messagesContainer;
      var prevScrollHeight = container.scrollHeight;

      prependMessagesToList(mid, newMsgs);

      // 追加後のscrollHeightの差分だけscrollTopを調整
      var addedHeight = container.scrollHeight - prevScrollHeight;
      container.scrollTop = container.scrollTop + addedHeight;

      updateLoadMoreIndicator(mid, false);
    });
  }

  function prependMessagesToList(mid, newMsgs) {
    if (!newMsgs || newMsgs.length === 0) return;
    var isGroup = selectedChat && selectedChat.isGroup;

    // 既存の日付区切りも含めて先頭に挿入するため、フラグメントを使う
    var frag = document.createDocumentFragment();
    var firstExistingDateStr = getFirstDateStrInList();

    // 新しいメッセージをグルーピングして日付区切りを挿入
    var lastDateStr = null;
    for (var i = 0; i < newMsgs.length; i += 1) {
      var msg = newMsgs[i];
      var msgDateStr = formatDateHeader(msg.createdTime);
      if (lastDateStr !== msgDateStr) {
        var dateDivider = document.createElement("li");
        dateDivider.className = "date-divider";
        var dateSpan = document.createElement("span");
        dateSpan.textContent = msgDateStr;
        dateDivider.appendChild(dateSpan);
        frag.appendChild(dateDivider);
        lastDateStr = msgDateStr;
      }
      var li = buildMessageEl(msg, isGroup);
      if (li) frag.appendChild(li);
    }

    // 最後の新メッセージの日付と既存先頭メッセージの日付が同じなら既存の日付区切りを削除
    if (lastDateStr && firstExistingDateStr && lastDateStr === firstExistingDateStr) {
      var existing = messageListEl.querySelector(".date-divider");
      if (existing) existing.parentNode.removeChild(existing);
    }

    // キャッシュにも追加してマージ
    messageCache[mid] = sortMessagesByCreatedTime(newMsgs.concat(messageCache[mid] || []));

    // フラグメントを先頭に挿入
    if (messageListEl.firstChild) {
      messageListEl.insertBefore(frag, messageListEl.firstChild);
    } else {
      messageListEl.appendChild(frag);
    }
  }

  function getFirstDateStrInList() {
    var items = messageListEl.querySelectorAll("li[data-id]");
    if (!items || items.length === 0) return null;
    var firstItem = items[0];
    // data-time 属性からdateStrを得る
    var t = firstItem.getAttribute("data-time");
    if (!t) return null;
    return formatDateHeader(Number(t));
  }

  function updateLoadMoreIndicator(mid, loading) {
    var indicator = document.getElementById("load-more-indicator");
    if (!indicator) return;
    if (!hasMoreMessages[mid] && !loading) {
      indicator.style.display = "none";
    } else {
      indicator.style.display = "";
      indicator.textContent = loading ? "読み込み中..." : "";
    }
  }

  function fetchReadStatus(mid, callback) {
    apiRequest("GET", "/api/chat/" + encodeURIComponent(mid) + "/read-status", null, function (status, data) {
      if (status >= 200 && status < 300 && data && data.readRanges) {
        readStatusCache[mid] = data.readRanges;
      }
      if (callback) callback();
    });
  }

  function fetchGroupMembers(mid) {
    apiRequest("GET", "/api/chat/" + encodeURIComponent(mid) + "/members", null, function (status, data) {
      if (status >= 200 && status < 300 && data && data.members) {
        groupMembersCache[mid] = data.members;
        // contactCache にもメンバーを追加
        for (var i = 0; i < data.members.length; i += 1) {
          var m = data.members[i];
          if (m && m.mid) {
            contactCache[String(m.mid)] = { mid: m.mid, name: m.name || m.mid, avatarUrl: m.avatarUrl };
          }
        }
      }
    });
  }

  // API レスポンス構造:
  // readRanges = [{ chatId, ranges: { readerMid: [ { 1: startMsgId, 2: endMsgId, 3: startTime, 4: endTime } ] } }]
  // フィールド 4 = endTime: そのユーザーが最後に読んだメッセージの作成時刻

  function getMaxEndTimeForReader(rangeEntries) {
    // rangeEntries = [ { 1: .., 2: .., 3: .., 4: endTime }, ... ]
    if (!rangeEntries || !rangeEntries.length) return 0;
    var maxEnd = 0;
    for (var j = 0; j < rangeEntries.length; j += 1) {
      var entry = rangeEntries[j];
      if (!entry) continue;
      // フィールド "4" = endTime
      var endTime = toTimestampMs(entry["4"] || entry.endTime || 0);
      if (endTime > maxEnd) maxEnd = endTime;
    }
    return maxEnd;
  }

  function getReadCountForMessage(msg, chatMid) {
    if (!msg || !myMid) return 0;
    var fromValue = msg.from ? String(msg.from) : "";
    // 自分のメッセージでなければ既読は表示しない
    if (!fromValue || fromValue !== String(myMid)) return 0;

    var rangesArr = readStatusCache[chatMid];
    if (!rangesArr || !rangesArr.length) return 0;

    var readCount = 0;
    var msgCreatedTime = toTimestampMs(msg.createdTime);
    if (!msgCreatedTime) return 0;

    for (var i = 0; i < rangesArr.length; i += 1) {
      var rangeObj = rangesArr[i];
      if (!rangeObj) continue;

      // ranges: { readerMid: [ entries ] }
      var rangesMap = rangeObj.ranges || {};
      for (var readerMid in rangesMap) {
        if (!rangesMap.hasOwnProperty(readerMid)) continue;
        if (readerMid === String(myMid)) continue;
        var maxEndTime = getMaxEndTimeForReader(rangesMap[readerMid]);
        if (maxEndTime > 0 && msgCreatedTime <= maxEndTime) {
          readCount += 1;
        }
      }
    }
    return readCount;
  }

  function isMessageRead(msg, chatMid) {
    return getReadCountForMessage(msg, chatMid) > 0;
  }

  function getReadersForMessage(msg, chatMid) {
    if (!msg || !myMid) return [];
    var fromValue = msg.from ? String(msg.from) : "";
    if (!fromValue || fromValue !== String(myMid)) return [];

    var rangesArr = readStatusCache[chatMid];
    if (!rangesArr || !rangesArr.length) return [];

    var readers = [];
    var msgCreatedTime = toTimestampMs(msg.createdTime);
    if (!msgCreatedTime) return [];

    for (var i = 0; i < rangesArr.length; i += 1) {
      var rangeObj = rangesArr[i];
      if (!rangeObj) continue;

      var rangesMap = rangeObj.ranges || {};
      for (var readerMid in rangesMap) {
        if (!rangesMap.hasOwnProperty(readerMid)) continue;
        if (readerMid === String(myMid)) continue;
        var maxEndTime = getMaxEndTimeForReader(rangesMap[readerMid]);
        if (maxEndTime > 0 && msgCreatedTime <= maxEndTime) {
          var cached = contactCache[readerMid];
          readers.push({
            mid: readerMid,
            name: cached ? cached.name : (String(readerMid).slice(0, 8) + "..."),
            avatarUrl: cached && cached.avatarUrl ? cached.avatarUrl : DEFAULT_AVATAR
          });
        }
      }
    }
    return readers;
  }

  function renderMessages(mid) {
    var messages = sortMessagesByCreatedTime(messageCache[mid] || []);
    var isGroup = selectedChat && selectedChat.isGroup;
    messageCache[mid] = messages;

    clearNode(messageListEl);

    // hasMoreMessages が true の場合はインジケーターを表示
    var indicator = document.getElementById("load-more-indicator");
    if (indicator) {
      if (hasMoreMessages[mid]) {
        indicator.style.display = "";
        indicator.textContent = "";
      } else {
        indicator.style.display = "none";
      }
    }

    if (messages.length === 0) {
      setMessageListMessage("メッセージがありません", false);
      scrollToBottomWithRetry();
      return;
    }

    var lastDateStr = null;

    for (var i = 0; i < messages.length; i += 1) {
      var msg = messages[i];
      var msgDateStr = formatDateHeader(msg.createdTime);
      if (lastDateStr !== msgDateStr) {
        var dateDivider = document.createElement("li");
        dateDivider.className = "date-divider";
        var dateSpan = document.createElement("span");
        dateSpan.textContent = msgDateStr;
        dateDivider.appendChild(dateSpan);
        messageListEl.appendChild(dateDivider);
        lastDateStr = msgDateStr;
      }
      appendMessageEl(msg, isGroup);
    }

    scrollToBottomWithRetry();
  }

  function getSenderName(fromMid) {
    if (!fromMid) return "";
    var cached = contactCache[String(fromMid)];
    if (cached && cached.name) return String(cached.name);
    return String(fromMid).slice(0, 8) + "...";
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function isImageMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 1 || ct === "IMAGE" || ct === "1";
  }

  function isStickerMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 7 || ct === "STICKER" || ct === "7";
  }

  function isVideoMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 2 || ct === "VIDEO" || ct === "2";
  }

  function isAudioMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 3 || ct === "AUDIO" || ct === "3";
  }

  function isFileMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 14 || ct === "FILE" || ct === "14";
  }

  function isSystemMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 18 || ct === "CHATEVENT" || ct === "18";
  }

  function isLocationMessage(msg) {
    var ct = msg && msg.contentType;
    return ct === 15 || ct === "LOCATION" || ct === "15";
  }

  function renderTextWithLinks(el, text) {
    var urlRegex = /https?:\/\/[^\s　「」（）『』【】、。，．]+/g;
    var parts = text.split(urlRegex);
    var matches = text.match(urlRegex) || [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) el.appendChild(document.createTextNode(parts[i]));
      if (matches[i]) {
        var a = document.createElement("a");
        a.href = matches[i];
        a.textContent = matches[i];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "msg-link";
        el.appendChild(a);
      }
    }
  }

  function getContentTypeLabel(msg) {
    var ct = msg && msg.contentType;
    var meta = (msg && msg.contentMetadata) || {};
    if (ct === 6 || ct === "CALL" || ct === "6") return "[通話]";
    if (ct === 13 || ct === "CONTACT" || ct === "13") {
      var name = meta.displayName || meta.MID || "";
      return name ? "[連絡先: " + name + "]" : "[連絡先]";
    }
    if (ct === 12 || ct === "LINK" || ct === "12") return "[リンク]";
    if (ct === 18 || ct === "CHATEVENT" || ct === "18") return "[システムメッセージ]";
    if (ct === 5 || ct === "PDF" || ct === "5") return "[PDF]";
    if (ct === 4 || ct === "HTML" || ct === "4") return "[HTML]";
    if (ct === 8 || ct === "PRESENCE" || ct === "8") return "[プレゼンス更新]";
    if (ct === 9 || ct === "GIFT" || ct === "9") return "[ギフト]";
    if (ct === 10 || ct === "GROUPBOARD" || ct === "10") return "[グループボード]";
    if (ct === 11 || ct === "APPLINK" || ct === "11") return "[アプリリンク]";
    if (ct === 16 || ct === "POSTNOTIFICATION" || ct === "16") return "[通知]";
    if (ct === 17 || ct === "RICH" || ct === "17") return "[リッチメッセージ]";
    if (ct === 19 || ct === "MUSIC" || ct === "19") return "[音楽]";
    if (ct === 20 || ct === "PAYMENT" || ct === "20") return "[支払い]";
    if (ct === 21 || ct === "EXTIMAGE" || ct === "21") return "[画像]";
    if (ct === 22 || ct === "FLEX" || ct === "22") return "[Flexメッセージ]";
    return "[メディア]";
  }

  function getStickerPreviewUrl(msg) {
    if (!isStickerMessage(msg)) return "";
    var metadata = msg && msg.contentMetadata ? msg.contentMetadata : null;
    var stickerId = metadata && metadata.STKID ? String(metadata.STKID) : "";
    if (!stickerId) return "";
    var isAnimated = metadata && String(metadata.STKOPT || "").toUpperCase() === "A";
    var fileName = isAnimated ? "sticker_animation.png" : "sticker.png";
    return "https://stickershop.line-scdn.net/stickershop/v1/sticker/"
      + encodeURIComponent(stickerId)
      + "/android/"
      + fileName;
  }

  function getStickerFallbackUrl(msg) {
    var metadata = msg && msg.contentMetadata ? msg.contentMetadata : null;
    var stickerId = metadata && metadata.STKID ? String(metadata.STKID) : "";
    if (!stickerId) return "";
    return "https://stickershop.line-scdn.net/stickershop/v1/sticker/"
      + encodeURIComponent(stickerId)
      + "/android/sticker.png";
  }

  function getStickerAltText(msg) {
    var metadata = msg && msg.contentMetadata ? msg.contentMetadata : null;
    var stickerText = metadata && metadata.STKTXT ? String(metadata.STKTXT) : "";
    if (stickerText) return stickerText;
    var stickerId = metadata && metadata.STKID ? String(metadata.STKID) : "";
    return stickerId ? ("スタンプ " + stickerId) : "スタンプ";
  }

  function appendMessageEl(msg, isGroup) {
    var li = buildMessageEl(msg, isGroup);
    if (li) messageListEl.appendChild(li);
  }

  function buildSystemMessageEl(msg) {
    var li = document.createElement("li");
    li.className = "msg msg-system";
    if (msg && msg.id) li.setAttribute("data-id", String(msg.id));
    if (msg && msg.createdTime) li.setAttribute("data-time", String(msg.createdTime));

    // テキスト抽出: msg.text → contentMetadata の各フィールド → デフォルト
    var text = (msg && msg.text) ? String(msg.text) : "";
    if (!text && msg && msg.contentMetadata) {
      text = msg.contentMetadata.MESSAGE || msg.contentMetadata.DISPLAY_MESSAGE ||
             msg.contentMetadata.BODY || msg.contentMetadata.TEXT || "";
    }
    if (!text) text = "[システムメッセージ]";

    var span = document.createElement("span");
    span.className = "msg-system-text";
    span.textContent = text;
    li.appendChild(span);
    return li;
  }

  function buildMessageEl(msg, isGroup) {
    if (isSystemMessage(msg)) {
      return buildSystemMessageEl(msg);
    }

    var li = document.createElement("li");
    var bubble = document.createElement("div");
    var time = document.createElement("div");
    var fromValue = msg && msg.from ? String(msg.from) : "";
    var isOut = myMid && fromValue && fromValue === String(myMid);
    var msgId = msg && msg.id ? String(msg.id) : "";

    li.className = "msg " + (isOut ? "outgoing" : "incoming");
    li.setAttribute("data-id", msgId);
    if (msg && msg.createdTime) li.setAttribute("data-time", String(msg.createdTime));

    // グループチャットで受信メッセージの場合、送信者名を表示
    if (isGroup && !isOut && fromValue) {
      var sender = document.createElement("div");
      sender.className = "msg-sender";
      sender.textContent = getSenderName(fromValue);
      li.appendChild(sender);
    }

    // 返信引用表示（バブルの前に追加）
    var relatedId = msg && msg.relatedMessageId ? String(msg.relatedMessageId) : "";
    if (relatedId) {
      li.appendChild(buildReplyQuote(relatedId));
    }

    if (isImageMessage(msg) && msgId) {
      bubble.className = "msg-bubble is-image";
      var imgEl = document.createElement("img");
      imgEl.className = "msg-image";
      imgEl.src = withAccount("/api/message/" + encodeURIComponent(msgId) + "/image?preview=1");
      imgEl.alt = "画像";
      imgEl.loading = "lazy";
      imgEl.onclick = function () {
        showImageLightbox(withAccount("/api/message/" + encodeURIComponent(msgId) + "/image"));
      };
      bubble.appendChild(imgEl);
    } else if (isVideoMessage(msg)) {
      if (msgId) {
        bubble.className = "msg-bubble is-video";
        var videoEl = document.createElement("video");
        videoEl.className = "msg-video";
        videoEl.src = withAccount("/api/message/" + encodeURIComponent(msgId) + "/video");
        videoEl.controls = true;
        videoEl.preload = "metadata";
        videoEl.playsInline = true;
        bubble.appendChild(videoEl);
      } else {
        bubble.className = "msg-bubble";
        bubble.textContent = "[動画]";
      }
    } else if (isStickerMessage(msg)) {
      var stickerUrl = getStickerPreviewUrl(msg);
      if (stickerUrl) {
        bubble.className = "msg-bubble is-image is-sticker";
        var stickerEl = document.createElement("img");
        stickerEl.className = "msg-sticker";
        stickerEl.src = stickerUrl;
        stickerEl.alt = getStickerAltText(msg);
        stickerEl.loading = "lazy";
        stickerEl.referrerPolicy = "no-referrer";
        stickerEl.onerror = function () {
          var fallback = getStickerFallbackUrl(msg);
          if (!fallback || stickerEl.src === fallback) return;
          stickerEl.src = fallback;
        };
        stickerEl.onclick = function () {
          window.open(stickerEl.src, "_blank");
        };
        bubble.appendChild(stickerEl);
      } else {
        bubble.className = "msg-bubble";
        bubble.textContent = "[スタンプ]";
      }
    } else if (isAudioMessage(msg) && msgId) {
      bubble.className = "msg-bubble is-audio";
      var audioEl = document.createElement("audio");
      audioEl.className = "msg-audio";
      audioEl.src = withAccount("/api/message/" + encodeURIComponent(msgId) + "/audio");
      audioEl.controls = true;
      audioEl.preload = "metadata";
      bubble.appendChild(audioEl);
    } else if (isFileMessage(msg) && msgId) {
      bubble.className = "msg-bubble is-file";
      var meta = (msg && msg.contentMetadata) || {};
      var fileName = meta.FILE_NAME || "ファイル";
      var fileSizeText = meta.FILE_SIZE ? formatFileSize(Number(meta.FILE_SIZE)) : "";
      var fileLink = document.createElement("a");
      fileLink.href = withAccount("/api/message/" + encodeURIComponent(msgId) + "/file?name=" + encodeURIComponent(fileName));
      fileLink.download = fileName;
      fileLink.className = "msg-file-card";

      var fileIcon = document.createElement("div");
      fileIcon.className = "msg-file-icon";
      fileIcon.textContent = "📄";

      var fileMeta = document.createElement("div");
      fileMeta.className = "msg-file-meta";
      var fileNameEl = document.createElement("div");
      fileNameEl.className = "msg-file-name";
      fileNameEl.textContent = fileName;
      var fileSubEl = document.createElement("div");
      fileSubEl.className = "msg-file-sub";
      fileSubEl.textContent = (fileSizeText ? fileSizeText + " · " : "") + "タップして保存";
      fileMeta.appendChild(fileNameEl);
      fileMeta.appendChild(fileSubEl);

      fileLink.appendChild(fileIcon);
      fileLink.appendChild(fileMeta);
      bubble.appendChild(fileLink);
    } else if (isLocationMessage(msg)) {
      bubble.className = "msg-bubble is-location";
      var loc = msg && msg.location;
      var locTitle = (loc && loc.title) || "";
      var locAddr = (loc && loc.address) || "";
      var locText = locTitle || locAddr || "[位置情報]";
      if (locTitle && locAddr && locTitle !== locAddr) locText = locTitle + "\n" + locAddr;
      if (loc && loc.latitude != null && loc.longitude != null) {
        var locLink = document.createElement("a");
        locLink.href = "https://maps.google.com/maps?q=" + loc.latitude + "," + loc.longitude;
        locLink.target = "_blank";
        locLink.rel = "noopener noreferrer";
        locLink.textContent = "📍 " + locText;
        locLink.className = "msg-location-link";
        bubble.appendChild(locLink);
      } else {
        bubble.textContent = "📍 " + locText;
      }
    } else {
      var isUnsent = msg && msg.contentMetadata && msg.contentMetadata.UNSENT === "true";
      if (isUnsent) {
        bubble.className = "msg-bubble msg-unsent-notice";
        bubble.textContent = "メッセージが取り消されました";
      } else {
        bubble.className = "msg-bubble";
        if (msg && msg.text) {
          renderTextWithLinks(bubble, String(msg.text));
        } else {
          bubble.textContent = getContentTypeLabel(msg);
        }
      }
    }

    time.className = "msg-time";
    time.textContent = formatTime(msg && msg.createdTime ? msg.createdTime : null);

    // 既読表示（自分の送信メッセージのみ）
    var readEl = null;
    if (isOut && selectedChat) {
      var chatMid = String(selectedChat.mid);
      if (isGroup) {
        var readCount = getReadCountForMessage(msg, chatMid);
        if (readCount > 0) {
          readEl = document.createElement("div");
          readEl.className = "msg-read msg-read-group";
          readEl.textContent = "既読 " + readCount;
          readEl.onclick = (function (m, cm) {
            return function () {
              showReadOverlay(m, cm);
            };
          })(msg, chatMid);
        }
      } else {
        if (isMessageRead(msg, chatMid)) {
          readEl = document.createElement("div");
          readEl.className = "msg-read";
          readEl.textContent = "既読";
        }
      }
    }

    li.appendChild(bubble);
    // 既読 + 時刻をまとめる
    if (readEl) {
      var metaWrap = document.createElement("div");
      metaWrap.className = "msg-meta";
      metaWrap.appendChild(readEl);
      metaWrap.appendChild(time);
      li.appendChild(metaWrap);
    } else {
      li.appendChild(time);
    }

    // コンテキストメニュー（全メッセージ：返信、自分のメッセージのみ：送信取り消しも）
    if (msgId) {
      attachMessageMenu(li, msgId, msg, !!isOut);
    }

    return li;
  }

  var unsendMenuEl = null;
  var unsendMenuTargetId = null;
  var unsendLongPressTimer = null;

  // 返信状態
  var replyTargetMsg = null;
  var replyPreviewEl = document.getElementById("reply-preview");
  var replyPreviewTextEl = document.getElementById("reply-preview-text");
  var replyCancelBtn = document.getElementById("reply-cancel-btn");

  function buildReplyQuote(relatedMsgId) {
    var quoteEl = document.createElement("div");
    quoteEl.className = "msg-reply-quote";

    // キャッシュから元メッセージを探す
    var originalMsg = null;
    if (selectedChat && selectedChat.mid) {
      var msgs = messageCache[String(selectedChat.mid)] || [];
      for (var i = 0; i < msgs.length; i += 1) {
        if (msgs[i] && String(msgs[i].id) === relatedMsgId) {
          originalMsg = msgs[i];
          break;
        }
      }
    }

    if (originalMsg) {
      var preview = getMessagePreviewText(originalMsg);
      var fromMid = originalMsg.from ? String(originalMsg.from) : "";
      var senderName = fromMid ? getSenderName(fromMid) : "";
      quoteEl.textContent = (senderName ? senderName + ": " : "") + preview;
    } else {
      quoteEl.textContent = "返信元メッセージ";
    }

    // クリックで元メッセージへスクロール
    quoteEl.onclick = (function (id) {
      return function (e) {
        e.stopPropagation();
        var target = messageListEl.querySelector('[data-id="' + id + '"]');
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      };
    })(relatedMsgId);

    return quoteEl;
  }

  function setReplyTarget(msg) {
    replyTargetMsg = msg;
    if (!msg) {
      if (replyPreviewEl) addClass(replyPreviewEl, "hidden");
      if (messagesContainer) messagesContainer.style.bottom = "64px";
      return;
    }
    var preview = getMessagePreviewText(msg);
    if (replyPreviewTextEl) replyPreviewTextEl.textContent = "返信: " + preview;
    if (replyPreviewEl) {
      removeClass(replyPreviewEl, "hidden");
      var previewH = replyPreviewEl.offsetHeight || 40;
      if (messagesContainer) messagesContainer.style.bottom = (64 + previewH) + "px";
    }
    if (messageInput) messageInput.focus();
  }

  function cancelReply() {
    setReplyTarget(null);
  }

  function getMessagePreviewText(msg) {
    if (!msg) return "";
    if (isImageMessage(msg)) return "[画像]";
    if (isVideoMessage(msg)) return "[動画]";
    if (isStickerMessage(msg)) return "[スタンプ]";
    if (isAudioMessage(msg)) return "[音声]";
    if (isFileMessage(msg)) return "[ファイル]";
    if (isLocationMessage(msg)) return "[位置情報]";
    if (msg.text) return String(msg.text).slice(0, 60);
    return getContentTypeLabel(msg);
  }

  function hideUnsendMenu() {
    if (unsendMenuEl) {
      unsendMenuEl.remove();
      unsendMenuEl = null;
    }
    unsendMenuTargetId = null;
  }

  function showUnsendMenu(li, msgId, msg, isOut) {
    hideUnsendMenu();
    unsendMenuTargetId = msgId;

    var menu = document.createElement("div");
    menu.className = "unsend-menu";
    menu.setAttribute("role", "menu");

    // 返信ボタン（全メッセージ）
    if (msg) {
      var replyBtn = document.createElement("button");
      replyBtn.className = "reply-menu-btn";
      replyBtn.textContent = "返信";
      replyBtn.setAttribute("role", "menuitem");
      replyBtn.onclick = (function (m) {
        return function (e) {
          e.stopPropagation();
          hideUnsendMenu();
          setReplyTarget(m);
        };
      })(msg);
      menu.appendChild(replyBtn);
    }

    // 送信取り消しボタン（自分のメッセージのみ）
    if (isOut) {
      var btn = document.createElement("button");
      btn.className = "unsend-menu-btn";
      btn.textContent = "送信取り消し";
      btn.setAttribute("role", "menuitem");
      btn.onclick = function (e) {
        e.stopPropagation();
        doUnsend(msgId);
      };
      menu.appendChild(btn);
    }

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "unsend-menu-cancel";
    cancelBtn.textContent = "キャンセル";
    cancelBtn.setAttribute("role", "menuitem");
    cancelBtn.onclick = function (e) {
      e.stopPropagation();
      hideUnsendMenu();
    };
    menu.appendChild(cancelBtn);

    // position:fixed でオーバーフロークリップを回避
    menu.style.position = "fixed";
    menu.style.zIndex = "500";
    document.body.appendChild(menu);
    unsendMenuEl = menu;

    // li の位置を基準に表示位置を決定
    var rect = li.getBoundingClientRect();
    var menuH = menu.offsetHeight || 100;
    var menuW = menu.offsetWidth || 140;
    var winH = window.innerHeight;
    var winW = window.innerWidth;

    // 下に収まるなら下、収まらなければ上に開く
    var top;
    if (rect.bottom + menuH + 4 <= winH) {
      top = rect.bottom + 4;
    } else {
      top = Math.max(rect.top - menuH - 4, 4);
    }
    // 右端がはみ出ないよう調整
    var left = Math.min(rect.right - menuW, winW - menuW - 8);
    left = Math.max(left, 8);

    menu.style.top = top + "px";
    menu.style.left = left + "px";

    // メニュー外タップで閉じる
    setTimeout(function () {
      document.addEventListener("click", hideUnsendMenu, { once: true });
    }, 0);
  }

  function attachMessageMenu(li, msgId, msg, isOut) {
    var longPressTimer = null;

    // 長押し (モバイル)
    li.addEventListener("touchstart", function (e) {
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        showUnsendMenu(li, msgId, msg, isOut);
      }, 600);
    }, { passive: true });
    li.addEventListener("touchend", function () {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    li.addEventListener("touchmove", function () {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    // 右クリック (デスクトップ)
    li.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      showUnsendMenu(li, msgId, msg, isOut);
    });
  }

  function doUnsend(msgId) {
    hideUnsendMenu();
    apiRequest("POST", "/api/message/" + encodeURIComponent(msgId) + "/unsend", null, function (status, data) {
      if (status < 200 || status >= 300) {
        alert("送信取り消しに失敗しました: " + ((data && data.error) || "不明なエラー"));
      }
    });
  }

  function showReadOverlay(msg, chatMid) {
    hideReadOverlay();
    var readers = getReadersForMessage(msg, chatMid);
    if (readers.length === 0) return;

    var overlay = document.createElement("div");
    overlay.id = "read-overlay";

    var inner = document.createElement("div");
    inner.id = "read-overlay-inner";

    var header = document.createElement("div");
    header.id = "read-overlay-header";

    var title = document.createTextNode("既読 " + readers.length + "人");
    header.appendChild(title);

    var closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.textContent = "×";
    closeBtn.onclick = hideReadOverlay;
    header.appendChild(closeBtn);

    var list = document.createElement("ul");
    list.id = "read-overlay-list";

    for (var i = 0; i < readers.length; i += 1) {
      var r = readers[i];
      var li = document.createElement("li");

      var avatar = document.createElement("img");
      avatar.className = "reader-avatar";
      avatar.src = r.avatarUrl || DEFAULT_AVATAR;
      avatar.alt = r.name || "";
      avatar.onerror = function () { this.src = DEFAULT_AVATAR; };

      var nameEl = document.createElement("div");
      nameEl.className = "reader-name";
      nameEl.textContent = r.name || r.mid;

      li.appendChild(avatar);
      li.appendChild(nameEl);
      list.appendChild(li);
    }

    inner.appendChild(header);
    inner.appendChild(list);
    overlay.appendChild(inner);
    document.body.appendChild(overlay);

    // 背景タップで閉じる
    overlay.onclick = function (e) {
      if (e.target === overlay) hideReadOverlay();
    };
  }

  function hideReadOverlay() {
    var existing = document.getElementById("read-overlay");
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  // --- 画像ライトボックス（拡大表示 + ダウンロード） ---

  function showImageLightbox(fullUrl) {
    hideImageLightbox();
    var overlay = document.createElement("div");
    overlay.id = "image-lightbox";

    var img = document.createElement("img");
    img.id = "image-lightbox-img";
    img.src = fullUrl;
    img.alt = "画像";

    var bar = document.createElement("div");
    bar.id = "image-lightbox-bar";

    var dl = document.createElement("a");
    dl.className = "lightbox-btn";
    dl.href = fullUrl;
    dl.setAttribute("download", "image.jpg");
    dl.textContent = "保存";

    var close = document.createElement("button");
    close.className = "lightbox-btn";
    close.type = "button";
    close.textContent = "閉じる";
    close.onclick = hideImageLightbox;

    bar.appendChild(dl);
    bar.appendChild(close);
    overlay.appendChild(img);
    overlay.appendChild(bar);
    document.body.appendChild(overlay);

    overlay.onclick = function (e) {
      if (e.target === overlay || e.target === img) hideImageLightbox();
    };
  }

  function hideImageLightbox() {
    var existing = document.getElementById("image-lightbox");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function onImageSelected() {
    if (!imageInput.files || !imageInput.files[0]) return;
    var file = imageInput.files[0];
    imageInput.value = "";
    sendImageFile(file);
  }

  function onImageAttachClick() {
    if (!imageInput || !selectedChat || !selectedChat.mid) return;
    if (imageAttachBtn && imageAttachBtn.disabled) return;

    if (typeof imageInput.showPicker === "function") {
      try {
        imageInput.showPicker();
        return;
      } catch (ignore) {
        // Fallback to click() for browsers that reject showPicker()
      }
    }
    imageInput.click();
  }

  function onMessageInputPaste(e) {
    if (!selectedChat || !selectedChat.mid) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    var i;
    for (i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf("image") === 0) {
        var file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          sendImageFile(file);
          return;
        }
      }
    }
  }

  function onChatAreaDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    addClass(chatArea, "dragging");
  }

  function onChatAreaDragLeave(e) {
    if (e.target === chatArea) {
      removeClass(chatArea, "dragging");
    }
  }

  function onChatAreaDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    removeClass(chatArea, "dragging");

    if (!selectedChat || !selectedChat.mid) return;
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files) return;

    var i;
    for (i = 0; i < files.length; i += 1) {
      sendAnyFile(files[i]);
    }
  }

  function sendImageFile(file) {
    if (!selectedChat || !selectedChat.mid) return;
    var toMid = String(selectedChat.mid);

    setUploadButtonsDisabled(true);
    showUploadProgress("画像を送信中...");

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/chat/" + encodeURIComponent(toMid) + "/send-image", true);
    if (activeAccountId) xhr.setRequestHeader("X-Account-Id", activeAccountId);
    xhr.setRequestHeader("Content-Type", file.type || "image/jpeg");
    if (xhr.upload) {
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setUploadProgress((e.loaded / e.total) * 100);
      };
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      setUploadButtonsDisabled(false);
      hideUploadProgress();

      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (ignore) {}

      if (xhr.status < 200 || xhr.status >= 300) {
        window.alert("画像の送信に失敗しました: " + (data && data.error ? data.error : xhr.status));
        return;
      }

      addOptimisticOutgoing(toMid, data && data.message, 1, "");
    };
    xhr.send(file);
  }

  function onVideoSelected() {
    if (!videoInput.files || !videoInput.files[0]) return;
    var file = videoInput.files[0];
    videoInput.value = "";
    sendVideoFile(file);
  }

  function onVideoAttachClick() {
    if (!videoInput || !selectedChat || !selectedChat.mid) return;
    if (videoAttachBtn && videoAttachBtn.disabled) return;

    if (typeof videoInput.showPicker === "function") {
      try {
        videoInput.showPicker();
        return;
      } catch (ignore) {
        // Fallback to click() for browsers that reject showPicker()
      }
    }
    videoInput.click();
  }

  function getVideoDurationMs(file, callback) {
    if (!window.URL || typeof window.URL.createObjectURL !== "function") {
      callback(0);
      return;
    }

    var objectUrl = window.URL.createObjectURL(file);
    var probeVideo = document.createElement("video");
    var finished = false;

    function cleanup() {
      probeVideo.removeAttribute("src");
      if (typeof probeVideo.load === "function") {
        probeVideo.load();
      }
      window.URL.revokeObjectURL(objectUrl);
    }

    function finish(durationMs) {
      if (finished) return;
      finished = true;
      cleanup();
      callback(durationMs);
    }

    var timeoutId = window.setTimeout(function () {
      finish(0);
    }, 3000);

    probeVideo.preload = "metadata";
    probeVideo.onloadedmetadata = function () {
      window.clearTimeout(timeoutId);
      var seconds = Number(probeVideo.duration);
      if (!isFinite(seconds) || seconds <= 0) {
        finish(0);
        return;
      }
      finish(Math.max(1, Math.round(seconds * 1000)));
    };
    probeVideo.onerror = function () {
      window.clearTimeout(timeoutId);
      finish(0);
    };
    probeVideo.src = objectUrl;
  }

  function sendVideoFile(file) {
    if (!selectedChat || !selectedChat.mid) return;
    var toMid = String(selectedChat.mid);

    setUploadButtonsDisabled(true);
    showUploadProgress("動画を送信中...");

    getVideoDurationMs(file, function (durationMs) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/chat/" + encodeURIComponent(toMid) + "/send-video", true);
      if (activeAccountId) xhr.setRequestHeader("X-Account-Id", activeAccountId);
      xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
      xhr.setRequestHeader("X-Video-Duration-Ms", String(durationMs || 0));
      if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) setUploadProgress((e.loaded / e.total) * 100);
        };
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        setUploadButtonsDisabled(false);
        hideUploadProgress();

        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (ignore) {}

        if (xhr.status < 200 || xhr.status >= 300) {
          window.alert("動画の送信に失敗しました: " + (data && data.error ? data.error : xhr.status));
          return;
        }

        addOptimisticOutgoing(toMid, data && data.message, 2, "");
      };
      xhr.send(file);
    });
  }

  // --- ファイル送信（任意の種類） ---

  function onFileSelected() {
    if (!fileInput.files || !fileInput.files[0]) return;
    var file = fileInput.files[0];
    fileInput.value = "";
    sendAnyFile(file);
  }

  function onFileAttachClick() {
    if (!fileInput || !selectedChat || !selectedChat.mid) return;
    if (fileAttachBtn && fileAttachBtn.disabled) return;
    if (typeof fileInput.showPicker === "function") {
      try { fileInput.showPicker(); return; } catch (ignore) {}
    }
    fileInput.click();
  }

  // 種類に応じて画像/動画/ファイルの適切な送信に振り分ける
  function sendAnyFile(file) {
    if (!file) return;
    var type = file.type || "";
    if (type.indexOf("image/") === 0) {
      sendImageFile(file);
    } else if (type.indexOf("video/") === 0) {
      sendVideoFile(file);
    } else {
      sendGenericFile(file);
    }
  }

  function setUploadButtonsDisabled(disabled) {
    sendBtn.disabled = disabled;
    if (imageAttachBtn) imageAttachBtn.disabled = disabled;
    if (videoAttachBtn) videoAttachBtn.disabled = disabled;
    if (fileAttachBtn) fileAttachBtn.disabled = disabled;
  }

  function showUploadProgress(label) {
    if (!uploadProgressEl) return;
    if (uploadProgressLabel) uploadProgressLabel.textContent = label || "アップロード中...";
    if (uploadProgressBar) uploadProgressBar.style.width = "0%";
    removeClass(uploadProgressEl, "hidden");
  }

  function setUploadProgress(percent) {
    if (uploadProgressBar) uploadProgressBar.style.width = Math.max(0, Math.min(100, percent)) + "%";
  }

  function hideUploadProgress() {
    if (uploadProgressEl) addClass(uploadProgressEl, "hidden");
  }

  function sendGenericFile(file) {
    if (!selectedChat || !selectedChat.mid) return;
    var toMid = String(selectedChat.mid);
    setUploadButtonsDisabled(true);
    showUploadProgress(file.name || "ファイル");

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/chat/" + encodeURIComponent(toMid) + "/send-file", true);
    if (activeAccountId) xhr.setRequestHeader("X-Account-Id", activeAccountId);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name || "file"));
    if (xhr.upload) {
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setUploadProgress((e.loaded / e.total) * 100);
      };
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      setUploadButtonsDisabled(false);
      hideUploadProgress();
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (ignore) {}
      if (xhr.status < 200 || xhr.status >= 300) {
        window.alert("ファイルの送信に失敗しました: " + (data && data.error ? data.error : xhr.status));
        return;
      }
      addOptimisticOutgoing(toMid, data && data.message, 14, "");
    };
    xhr.send(file);
  }

  // 送信成功時に楽観的にメッセージをUIへ追加する共通処理
  function addOptimisticOutgoing(toMid, serverMessage, fallbackContentType, text) {
    var now = (new Date()).getTime();
    var createdTime = toTimestampMs(serverMessage && serverMessage.createdTime);
    if (!createdTime) createdTime = now;
    var msg = {
      id: serverMessage && serverMessage.id ? String(serverMessage.id) : String(now),
      from: serverMessage && serverMessage.from ? String(serverMessage.from) : (myMid ? myMid : "__me__"),
      to: serverMessage && serverMessage.to ? String(serverMessage.to) : toMid,
      text: text || (serverMessage && serverMessage.text ? serverMessage.text : ""),
      contentType: serverMessage && serverMessage.contentType ? serverMessage.contentType : fallbackContentType,
      contentMetadata: serverMessage && serverMessage.contentMetadata ? serverMessage.contentMetadata : {},
      createdTime: createdTime
    };
    cacheMessage(toMid, msg);
    updateChatLastMessageTime(toMid, createdTime);
    setChatPreview(toMid, getMessagePreviewText(msg));
    if (selectedChat && String(selectedChat.mid) === toMid) {
      renderMessages(toMid);
      scrollToBottomWithRetry();
    }
  }

  function onSendSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    sendCurrentMessage();
    return false;
  }

  function onMessageInputFocus() {
    if (!selectedChat || !selectedChat.mid) return;
    scrollToBottomWithRetry();
  }

  function onMessageKeyDown(e) {
    var keyCode = e && (e.keyCode || e.which);
    if (keyCode === 13 && !e.shiftKey) {
      if (e.preventDefault) e.preventDefault();
      sendCurrentMessage();
      return false;
    }
    return onComposeControlKeyDown(e);
  }

  function onComposeControlKeyDown(e) {
    var keyCode = e && (e.keyCode || e.which);
    if (keyCode !== 37 && keyCode !== 38 && keyCode !== 39 && keyCode !== 40) {
      return true;
    }

    var controls = [];
    if (imageAttachBtn) controls.push(imageAttachBtn);
    if (videoAttachBtn) controls.push(videoAttachBtn);
    if (fileAttachBtn) controls.push(fileAttachBtn);
    controls.push(messageInput);
    controls.push(sendBtn);

    var target = e && e.target ? e.target : null;
    var currentIndex = controls.indexOf(target);
    if (currentIndex === -1) return true;

    // モバイル表示では、画像ボタンから左キーで戻るボタンへ移動できるようにする
    if (keyCode === 37 && imageAttachBtn && target === imageAttachBtn) {
      var canFocusBackToFriends = backToFriendsBtn &&
        !backToFriendsBtn.disabled &&
        backToFriendsBtn.offsetParent !== null;
      if (canFocusBackToFriends) {
        if (e.preventDefault) e.preventDefault();
        backToFriendsBtn.focus();
        return false;
      }
    }

    // テキスト入力中は通常のカーソル移動を優先し、端まで移動したときだけフォーカス移動する
    if (target === messageInput) {
      var selectionStart = typeof messageInput.selectionStart === "number" ? messageInput.selectionStart : 0;
      var selectionEnd = typeof messageInput.selectionEnd === "number" ? messageInput.selectionEnd : 0;
      var valueLength = (messageInput.value || "").length;
      var isAtStart = selectionStart === 0 && selectionEnd === 0;
      var isAtEnd = selectionStart === valueLength && selectionEnd === valueLength;

      if ((keyCode === 37 || keyCode === 38) && !isAtStart) return true;
      if ((keyCode === 39 || keyCode === 40) && !isAtEnd) return true;
    }

    var nextIndex = currentIndex;
    if (keyCode === 37 || keyCode === 38) {
      nextIndex = Math.max(0, currentIndex - 1);
    } else {
      nextIndex = Math.min(controls.length - 1, currentIndex + 1);
    }
    if (nextIndex === currentIndex) return true;

    var nextEl = controls[nextIndex];
    if (!nextEl || nextEl.disabled) return true;
    if (e.preventDefault) e.preventDefault();
    nextEl.focus();
    if (nextEl === messageInput) {
      var messageLength = (messageInput.value || "").length;
      var cursorPos;
      if (target === sendBtn) {
        cursorPos = messageLength;
      } else if (
        (imageAttachBtn && target === imageAttachBtn) ||
        (videoAttachBtn && target === videoAttachBtn)
      ) {
        cursorPos = 0;
      } else {
        cursorPos = (keyCode === 37 || keyCode === 38) ? 0 : messageLength;
      }
      if (messageInput.setSelectionRange) {
        messageInput.setSelectionRange(cursorPos, cursorPos);
      }
    }
    return false;
  }

  function sendCurrentMessage() {
    if (!selectedChat || !selectedChat.mid) return;

    var text = trim(messageInput.value);
    if (!text) return;

    var toMid = String(selectedChat.mid);
    var replyId = replyTargetMsg && replyTargetMsg.id ? String(replyTargetMsg.id) : null;
    var disableInputDuringSend = !isLegacyIOS6Browser;
    sendBtn.disabled = true;
    if (imageAttachBtn) imageAttachBtn.disabled = true;
    if (videoAttachBtn) videoAttachBtn.disabled = true;
    if (disableInputDuringSend) {
      messageInput.disabled = true;
    }

    var payload = { text: text };
    if (replyId) payload.relatedMessageId = replyId;

    apiRequest("POST", "/api/chat/" + encodeURIComponent(toMid) + "/send", payload, function (status, data) {
      if (status < 200 || status >= 300) {
        var errorMessage = data && data.error ? data.error : "送信に失敗しました";
        window.alert("送信に失敗しました: " + errorMessage);
        sendBtn.disabled = false;
        if (imageAttachBtn) imageAttachBtn.disabled = false;
        if (videoAttachBtn) videoAttachBtn.disabled = false;
        if (disableInputDuringSend) {
          messageInput.disabled = false;
        }
        focusMessageInputAfterSend();
        return;
      }

      var now = (new Date()).getTime();
      var serverMessage = data && data.message ? data.message : null;
      var createdTime = toTimestampMs(serverMessage && serverMessage.createdTime);
      if (!createdTime) createdTime = now;
      var msg = {
        id: serverMessage && serverMessage.id ? String(serverMessage.id) : String(now),
        from: serverMessage && serverMessage.from ? String(serverMessage.from) : (myMid ? myMid : "__me__"),
        to: serverMessage && serverMessage.to ? String(serverMessage.to) : toMid,
        text: text,
        contentType: serverMessage && serverMessage.contentType ? serverMessage.contentType : "NONE",
        createdTime: createdTime
      };
      if (replyId) msg.relatedMessageId = replyId;

      cacheMessage(toMid, msg);
      updateChatLastMessageTime(toMid, now);

      if (selectedChat && String(selectedChat.mid) === toMid) {
        renderMessages(toMid);
      }

      messageInput.value = "";
      adjustTextarea();
      cancelReply();
      sendBtn.disabled = false;
      if (imageAttachBtn) imageAttachBtn.disabled = false;
      if (videoAttachBtn) videoAttachBtn.disabled = false;
      if (disableInputDuringSend) {
        messageInput.disabled = false;
      }
      focusMessageInputAfterSend();
      scrollToBottomWithRetry();
    });
  }

  // --- UI helpers ---

  function setupAppFrame() {
    if (isLegacyIOS6Browser) {
      addClass(document.body, "legacy-ios6-browser");
    }
    syncDisplayMode();
    syncFullscreenButton();

    if (window.matchMedia) {
      var media = window.matchMedia("(display-mode: standalone)");
      if (media.addEventListener) {
        media.addEventListener("change", onDisplayModeChange);
      } else if (media.addListener) {
        media.addListener(onDisplayModeChange);
      }
    }

    document.addEventListener("fullscreenchange", syncFullscreenButton);
    document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
  }

  function onDisplayModeChange() {
    syncDisplayMode();
    syncFullscreenButton();
  }

  function isStandaloneMode() {
    var mediaStandalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    return !!(mediaStandalone || window.navigator.standalone === true);
  }

  function syncDisplayMode() {
    if (isStandaloneMode()) {
      addClass(document.body, "standalone-mode");
    } else {
      removeClass(document.body, "standalone-mode");
    }
  }

  function supportsFullscreen() {
    var root = document.documentElement;
    return !!(
      root.requestFullscreen ||
      root.webkitRequestFullscreen ||
      document.fullscreenEnabled ||
      document.webkitFullscreenEnabled
    );
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function syncFullscreenButton() {
    if (!fullscreenBtn) return;

    if (!supportsFullscreen() || isStandaloneMode()) {
      addClass(fullscreenBtn, "hidden");
      return;
    }

    removeClass(fullscreenBtn, "hidden");
    fullscreenBtn.textContent = isFullscreen() ? "全画面終了" : "全画面";
  }

  function onToggleFullscreen() {
    if (isFullscreen()) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
      return;
    }

    var root = document.documentElement;
    if (root.requestFullscreen) {
      root.requestFullscreen();
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function (error) {
        console.warn("[sw] registration failed:", error);
      });
    });

    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "notification:click") {
        var aid = event.data.accountId;
        var chatMid = event.data.chatMid;
        if (aid && String(aid) !== String(activeAccountId) && findAccount(aid)) {
          // 別アカウント宛の通知: アカウントを切り替えてから対象チャットを開く
          switchAccount(aid, false);
          if (chatMid) {
            setTimeout(function () { openChatByMid(chatMid); }, 700);
          }
        } else if (chatMid) {
          openChatByMid(chatMid);
        }
      }
    });
  }

  function ensureNotificationPermission(cb) {
    var done = false;
    function finish() { if (done) return; done = true; if (cb) cb(); }
    if (!("Notification" in window)) { finish(); return; }
    if (Notification.permission !== "default") { finish(); return; }
    try {
      var p = Notification.requestPermission(finish);
      if (p && p.then) p.then(finish);
    } catch (e) {
      finish();
    }
  }

  // --- PWA Push 購読 ---

  function registerPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    apiRequest("GET", "/api/push/public-key", null, function (status, data) {
      if (status < 200 || status >= 300 || !data || !data.publicKey) return;
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (existing) {
          if (existing) return existing;
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(data.publicKey)
          });
        });
      }).then(function (sub) {
        if (!sub) return;
        pushActive = true;
        apiRequest("POST", "/api/push/subscribe",
          { subscription: sub.toJSON ? sub.toJSON() : sub }, function () {});
      }).catch(function (e) {
        console.warn("[push] subscribe failed:", e && e.message ? e.message : e);
      });
    });
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function showNewMessageNotification(chatMid, msg) {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    var isGroup = chatMid && chatMid.charAt(0) === "c";
    var senderMid = msg.from ? String(msg.from) : "";
    var senderName = senderMid;
    var i;

    if (contactCache[senderMid] && contactCache[senderMid].name) {
      senderName = contactCache[senderMid].name;
    } else {
      for (i = 0; i < friends.length; i += 1) {
        if (friends[i] && String(friends[i].mid) === senderMid) {
          senderName = friends[i].name || senderMid;
          break;
        }
      }
    }

    var title, body;
    if (isGroup) {
      var groupName = chatMid;
      for (i = 0; i < groups.length; i += 1) {
        if (groups[i] && String(groups[i].mid) === chatMid) {
          groupName = groups[i].name || chatMid;
          break;
        }
      }
      title = groupName;
      body = senderName + ": " + getMessagePreviewText(msg);
    } else {
      title = senderName;
      body = getMessagePreviewText(msg);
    }

    var opts = {
      body: body,
      icon: "/icons/app-icon-192.png",
      tag: chatMid,
      renotify: true,
      data: { chatMid: chatMid }
    };

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(function (reg) {
        reg.showNotification(title, opts);
      }).catch(function () {
        try { new Notification(title, opts); } catch (e) {}
      });
    } else {
      try { new Notification(title, opts); } catch (e) {}
    }
  }

  function openChatByMid(chatMid) {
    if (!chatMid) return;
    var i;
    for (i = 0; i < friends.length; i += 1) {
      if (friends[i] && String(friends[i].mid) === chatMid) {
        openChat({ mid: friends[i].mid, name: friends[i].name, avatarUrl: friends[i].avatarUrl, isGroup: false });
        return;
      }
    }
    for (i = 0; i < groups.length; i += 1) {
      if (groups[i] && String(groups[i].mid) === chatMid) {
        openChat({ mid: groups[i].mid, name: groups[i].name, avatarUrl: groups[i].avatarUrl, isGroup: true });
        return;
      }
    }
  }

  function setStatus(msg, type) {
    loginStatus.textContent = msg || "";
    loginStatus.className = "status-msg";
    if (type) loginStatus.className += " " + type;
  }

  function setLoginBusy(busy) {
    loginBtn.disabled = !!busy;
    qrStartBtn.disabled = !!busy;
    loginBtn.textContent = busy ? "接続中..." : "ログイン";
  }

  function showScreen(name) {
    if (name === "chat") {
      addClass(loginScreen, "hidden");
      removeClass(chatScreen, "hidden");
    } else {
      removeClass(loginScreen, "hidden");
      addClass(chatScreen, "hidden");
      closeChatForMobile();
    }
  }

  function openChatForMobile() { addClass(document.body, "chat-open"); }
  function closeChatForMobile() { removeClass(document.body, "chat-open"); }

  function setListMessage(listEl, text, isError) {
    clearNode(listEl);
    var li = document.createElement("li");
    li.className = "loading";
    if (isError) li.style.color = "#d32f2f";
    li.appendChild(document.createTextNode(text));
    listEl.appendChild(li);
  }

  function setMessageListMessage(text, isError) {
    setListMessage(messageListEl, text, isError);
  }

  function scrollToBottom() {
    var container = messagesContainer;
    if (container) container.scrollTop = container.scrollHeight;
  }

  function scrollToBottomWithRetry() {
    scrollToBottom();
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        scrollToBottom();
      });
    }
    window.setTimeout(scrollToBottom, 80);
    window.setTimeout(scrollToBottom, 200);
  }

  function focusMessageInputAfterSend() {
    if (!messageInput || messageInput.disabled) return;
    if (isLegacyIOS6Browser) {
      stabilizeLegacyIOSViewport();
      return;
    }
    messageInput.focus();
  }

  function stabilizeLegacyIOSViewport() {
    if (!isLegacyIOS6Browser || typeof window.scrollTo !== "function") return;
    window.setTimeout(function () { window.scrollTo(0, 0); }, 0);
    window.setTimeout(function () { window.scrollTo(0, 0); }, 120);
  }

  function adjustTextarea() {
    var maxHeight = 120;
    messageInput.style.height = "auto";
    var newHeight = messageInput.scrollHeight;
    if (newHeight < 38) newHeight = 38;
    if (newHeight > maxHeight) newHeight = maxHeight;
    messageInput.style.height = newHeight + "px";
  }

  // メディア等の直リンクURLにアクティブアカウントを付与する（ヘッダを使えない <img> 等向け）
  function withAccount(url) {
    if (!activeAccountId) return url;
    var sep = url.indexOf("?") === -1 ? "?" : "&";
    return url + sep + "account=" + encodeURIComponent(activeAccountId);
  }

  function apiRequest(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (activeAccountId) xhr.setRequestHeader("X-Account-Id", activeAccountId);
    xhr.onreadystatechange = function () {
      var response = null;
      if (xhr.readyState !== 4) return;
      if (xhr.responseText) {
        try { response = JSON.parse(xhr.responseText); } catch (ignore) { response = null; }
      }
      callback(xhr.status, response, xhr);
    };
    if (body) {
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(body));
    } else {
      xhr.send(null);
    }
  }

  function createInfoNode(text) {
    var p = document.createElement("p");
    p.className = "hint";
    p.appendChild(document.createTextNode(text));
    return p;
  }

  function clearNode(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function hasClass(el, className) {
    return (" " + el.className + " ").indexOf(" " + className + " ") !== -1;
  }

  function addClass(el, className) {
    if (!hasClass(el, className)) el.className = trim(el.className + " " + className);
  }

  function removeClass(el, className) {
    var reg = new RegExp("(^|\\s)" + className + "(?=\\s|$)", "g");
    el.className = trim((el.className || "").replace(reg, " "));
  }

  function formatTime(ts) {
    var d = ts ? new Date(ts) : new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function formatDateHeader(ts) {
    var today = new Date();
    var d = ts ? new Date(ts) : new Date();
    
    // reset time parts for comparison
    today.setHours(0,0,0,0);
    var targetDate = new Date(d);
    targetDate.setHours(0,0,0,0);
    
    var diffMs = today.getTime() - targetDate.getTime();
    var diffDays = Math.round(diffMs / 86400000);
    
    if (diffDays === 0) {
      return "今日";
    } else if (diffDays === 1) {
      return "昨日";
    } else {
      return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate());
    }
  }

  function pad2(num) { return num < 10 ? "0" + num : String(num); }

  function trim(value) { return String(value || "").replace(/^\s+|\s+$/g, ""); }

  function detectLegacyIOS6Browser() {
    var nav = window.navigator || {};
    var ua = nav.userAgent ? String(nav.userAgent) : "";
    if (!ua) return false;
    if (!/iP(hone|od|ad)/.test(ua)) return false;
    var match = ua.match(/OS (\d+)_/);
    if (!match) return false;
    var major = parseInt(match[1], 10);
    if (!isFinite(major)) return false;
    return major <= 6;
  }
}());
