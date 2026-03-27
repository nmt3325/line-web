(function () {
  var socket = io();

  var myMid = null;
  var selectedChat = null; // { mid, name, avatarUrl, isGroup }
  var friends = [];
  var groups = [];
  var messageCache = {};
  // mid -> { mid, name } for group sender display
  var contactCache = {};
  var DEFAULT_AVATAR = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

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

  var chatPlaceholder = document.getElementById("chat-placeholder");
  var chatPanel = document.getElementById("chat-panel");
  var backToFriendsBtn = document.getElementById("back-to-friends");
  var chatAvatar = document.getElementById("chat-avatar");
  var chatName = document.getElementById("chat-name");
  var messageListEl = document.getElementById("message-list");
  var sendForm = document.getElementById("send-form");
  var messageInput = document.getElementById("message-input");
  var sendBtn = document.getElementById("send-btn");

  setupLoginTabs();
  setupSidebarTabs();
  bindEvents();
  socket.emit("auth:auto");
  bindSocketEvents();

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
    backToFriendsBtn.onclick = onBackToFriends;
    friendSearch.onkeyup = onFriendSearch;
    friendSearch.oninput = onFriendSearch;
    groupSearch.onkeyup = onGroupSearch;
    groupSearch.oninput = onGroupSearch;
    sendForm.onsubmit = onSendSubmit;
    messageInput.oninput = adjustTextarea;
    messageInput.onkeyup = adjustTextarea;
    messageInput.onkeydown = onMessageKeyDown;
  }

  function bindSocketEvents() {
    socket.on("auth:none", function () {
      setLoginBusy(false);
      closeChatForMobile();
      showScreen("login");
    });

    socket.on("auth:success", function () {
      showScreen("chat");
      closeChatForMobile();
      fetchProfile();
      loadFriends();
      loadGroups();
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

    socket.on("chat:message", function (msg) {
      if (!msg) return;

      var fromStr = msg.from ? String(msg.from) : "";
      var toStr = msg.to ? String(msg.to) : "";
      var isOutgoing = myMid && fromStr && fromStr === String(myMid);

      // 自分が送信したメッセージはsendCurrentMessage()で既にUIに追加済みのためスキップ
      if (isOutgoing) return;

      // グループチャット: to が 'c' で始まる場合、chatMid = to
      var chatMid;
      if (toStr && toStr.charAt(0) === "c") {
        chatMid = toStr;
      } else {
        chatMid = isOutgoing ? toStr : fromStr;
      }

      if (!chatMid) return;

      if (!messageCache[chatMid]) {
        messageCache[chatMid] = [];
      }
      messageCache[chatMid].push(msg);

      if (selectedChat && String(selectedChat.mid) === chatMid) {
        appendMessageEl(msg, selectedChat.isGroup);
        scrollToBottom();
      }
    });
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
    if (!window.confirm("ログアウトしますか？")) return;
    apiRequest("POST", "/api/auth/logout", null, function () {
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
      friends = data && data.friends ? data.friends : [];
      // キャッシュに登録
      for (var i = 0; i < friends.length; i += 1) {
        if (friends[i] && friends[i].mid) {
          contactCache[String(friends[i].mid)] = { mid: friends[i].mid, name: friends[i].name || friends[i].mid };
        }
      }
      renderFriendList(friends);
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
    var li = document.createElement("li");
    var img = document.createElement("img");
    var info = document.createElement("div");
    var name = document.createElement("div");
    var status = document.createElement("div");

    li.className = "friend-item";
    li.setAttribute("data-mid", friend && friend.mid ? String(friend.mid) : "");
    li.onclick = function () {
      openChat({ mid: friend.mid, name: friend.name, avatarUrl: friend.avatarUrl, isGroup: false });
    };

    img.className = "friend-avatar";
    img.alt = friend && friend.name ? String(friend.name) : "";
    img.src = friend && friend.avatarUrl ? String(friend.avatarUrl) : DEFAULT_AVATAR;
    img.onerror = function () { this.src = DEFAULT_AVATAR; };

    info.className = "friend-info";
    name.className = "friend-name";
    name.textContent = friend && friend.name ? String(friend.name) : "(no name)";
    status.className = "friend-status";
    status.textContent = friend && friend.statusMessage ? String(friend.statusMessage) : "";

    info.appendChild(name);
    info.appendChild(status);
    li.appendChild(img);
    li.appendChild(info);
    friendList.appendChild(li);
  }

  function onFriendSearch() {
    var q = trim(friendSearch.value).toLowerCase();
    var filtered = [];
    for (var i = 0; i < friends.length; i += 1) {
      var n = friends[i] && friends[i].name ? String(friends[i].name).toLowerCase() : "";
      if (!q || n.indexOf(q) !== -1) filtered.push(friends[i]);
    }
    renderFriendList(filtered);
  }

  // --- Groups ---

  function loadGroups() {
    setListMessage(groupList, "読み込み中...", false);
    apiRequest("GET", "/api/groups", null, function (status, data) {
      if (status < 200 || status >= 300) {
        setListMessage(groupList, data && data.error ? data.error : "グループ一覧の取得に失敗しました", true);
        return;
      }
      groups = data && data.groups ? data.groups : [];
      renderGroupList(groups);
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
    var li = document.createElement("li");
    var img = document.createElement("img");
    var info = document.createElement("div");
    var name = document.createElement("div");
    var sub = document.createElement("div");

    li.className = "friend-item";
    li.setAttribute("data-mid", group && group.mid ? String(group.mid) : "");
    li.onclick = function () {
      openChat({ mid: group.mid, name: group.name, avatarUrl: group.avatarUrl, isGroup: true });
    };

    img.className = "friend-avatar";
    img.alt = group && group.name ? String(group.name) : "";
    img.src = group && group.avatarUrl ? String(group.avatarUrl) : DEFAULT_AVATAR;
    img.onerror = function () { this.src = DEFAULT_AVATAR; };

    info.className = "friend-info";
    name.className = "friend-name";
    name.textContent = group && group.name ? String(group.name) : "(no name)";
    sub.className = "friend-status";
    sub.textContent = group && group.memberCount ? group.memberCount + "人" : "";

    info.appendChild(name);
    info.appendChild(sub);
    li.appendChild(img);
    li.appendChild(info);
    groupList.appendChild(li);
  }

  function onGroupSearch() {
    var q = trim(groupSearch.value).toLowerCase();
    var filtered = [];
    for (var i = 0; i < groups.length; i += 1) {
      var n = groups[i] && groups[i].name ? String(groups[i].name).toLowerCase() : "";
      if (!q || n.indexOf(q) !== -1) filtered.push(groups[i]);
    }
    renderGroupList(filtered);
  }

  // --- Chat ---

  function openChat(chat) {
    var mid = chat && chat.mid ? String(chat.mid) : "";
    if (!mid) return;

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
    apiRequest("GET", "/api/chat/" + encodeURIComponent(mid) + "/messages?limit=30", null, function (status, data) {
      if (status < 200 || status >= 300) {
        setMessageListMessage(data && data.error ? data.error : "メッセージ取得に失敗しました", true);
        return;
      }
      messageCache[mid] = data && data.messages ? data.messages : [];
      renderMessages(mid);
    });
  }

  function renderMessages(mid) {
    var messages = messageCache[mid] || [];
    var isGroup = selectedChat && selectedChat.isGroup;

    clearNode(messageListEl);

    if (messages.length === 0) {
      setMessageListMessage("メッセージがありません", false);
      scrollToBottom();
      return;
    }

    for (var i = 0; i < messages.length; i += 1) {
      appendMessageEl(messages[i], isGroup);
    }

    scrollToBottom();
  }

  function getSenderName(fromMid) {
    if (!fromMid) return "";
    var cached = contactCache[String(fromMid)];
    if (cached && cached.name) return String(cached.name);
    return String(fromMid).slice(0, 8) + "...";
  }

  function appendMessageEl(msg, isGroup) {
    var li = document.createElement("li");
    var bubble = document.createElement("div");
    var time = document.createElement("div");
    var fromValue = msg && msg.from ? String(msg.from) : "";
    var isOut = myMid && fromValue && fromValue === String(myMid);

    li.className = "msg " + (isOut ? "outgoing" : "incoming");
    li.setAttribute("data-id", msg && msg.id ? String(msg.id) : "");

    // グループチャットで受信メッセージの場合、送信者名を表示
    if (isGroup && !isOut && fromValue) {
      var sender = document.createElement("div");
      sender.className = "msg-sender";
      sender.textContent = getSenderName(fromValue);
      li.appendChild(sender);
    }

    bubble.className = "msg-bubble";
    bubble.textContent = msg && msg.text ? String(msg.text) : "[メディア]";

    time.className = "msg-time";
    time.textContent = formatTime(msg && msg.createdTime ? msg.createdTime : null);

    li.appendChild(bubble);
    li.appendChild(time);
    messageListEl.appendChild(li);
  }

  function onSendSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    sendCurrentMessage();
    return false;
  }

  function onMessageKeyDown(e) {
    var keyCode = e && (e.keyCode || e.which);
    if (keyCode === 13 && !e.shiftKey) {
      if (e.preventDefault) e.preventDefault();
      sendCurrentMessage();
      return false;
    }
    return true;
  }

  function sendCurrentMessage() {
    if (!selectedChat || !selectedChat.mid) return;

    var text = trim(messageInput.value);
    if (!text) return;

    var toMid = String(selectedChat.mid);
    sendBtn.disabled = true;
    messageInput.disabled = true;

    apiRequest("POST", "/api/chat/" + encodeURIComponent(toMid) + "/send", { text: text }, function (status, data) {
      if (status < 200 || status >= 300) {
        var errorMessage = data && data.error ? data.error : "送信に失敗しました";
        window.alert("送信に失敗しました: " + errorMessage);
        sendBtn.disabled = false;
        messageInput.disabled = false;
        messageInput.focus();
        return;
      }

      var now = (new Date()).getTime();
      var msg = {
        id: String(now),
        from: myMid ? myMid : "__me__",
        to: toMid,
        text: text,
        createdTime: now
      };

      if (!messageCache[toMid]) messageCache[toMid] = [];
      messageCache[toMid].push(msg);

      if (selectedChat && String(selectedChat.mid) === toMid) {
        appendMessageEl(msg, selectedChat.isGroup);
        scrollToBottom();
      }

      messageInput.value = "";
      adjustTextarea();
      sendBtn.disabled = false;
      messageInput.disabled = false;
      messageInput.focus();
    });
  }

  // --- UI helpers ---

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
    var container = document.getElementById("messages-container");
    if (container) container.scrollTop = container.scrollHeight;
  }

  function adjustTextarea() {
    var maxHeight = 120;
    messageInput.style.height = "auto";
    var newHeight = messageInput.scrollHeight;
    if (newHeight < 38) newHeight = 38;
    if (newHeight > maxHeight) newHeight = maxHeight;
    messageInput.style.height = newHeight + "px";
  }

  function apiRequest(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
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

  function pad2(num) { return num < 10 ? "0" + num : String(num); }

  function trim(value) { return String(value || "").replace(/^\s+|\s+$/g, ""); }
}());
