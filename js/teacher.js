(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Проверка конфигурации ----------
  if (!window.FIREBASE_CONFIG_IS_SET || !window.FIREBASE_CONFIG_IS_SET()) {
    $('view-setup').style.display = 'block';
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  var currentUser = null;
  var textsCache = []; // [{id, title, level, sentences, ...}]
  var activeSessionCode = null;
  var unsubSession = null;
  var unsubParticipants = null;
  var participantsCache = {};

  /* ---------------- Аутентификация ---------------- */

  auth.onAuthStateChanged(function (user) {
    currentUser = user;
    if (user) {
      $('view-login').style.display = 'none';
      $('view-app').style.display = 'block';
      $('user-badge').style.display = 'block';
      $('user-email').textContent = user.email;
      $('session-card').style.display = 'block';
      subscribeTexts();
    } else {
      $('view-app').style.display = 'none';
      $('user-badge').style.display = 'none';
      $('view-login').style.display = 'block';
    }
  });

  $('login-btn').addEventListener('click', function () {
    var email = $('login-email').value.trim();
    var pass = $('login-password').value;
    $('login-error').style.display = 'none';
    if (!email || !pass) return;
    $('login-btn').disabled = true;
    auth.signInWithEmailAndPassword(email, pass).catch(function (err) {
      $('login-error').textContent = 'Не получилось войти: ' + describeAuthError(err);
      $('login-error').style.display = 'block';
    }).finally(function () { $('login-btn').disabled = false; });
  });

  function describeAuthError(err) {
    if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
      return 'проверьте email и пароль (создать логин можно в Firebase Console → Authentication → Users).';
    }
    return err.message;
  }

  $('logout-link').addEventListener('click', function (e) {
    e.preventDefault();
    auth.signOut();
  });

  /* ---------------- Библиотека текстов ---------------- */

  $('add-text-btn').addEventListener('click', function () {
    $('add-text-form').style.display = 'block';
  });
  $('cancel-text-btn').addEventListener('click', function () {
    $('add-text-form').style.display = 'none';
    $('new-title').value = ''; $('new-text').value = '';
  });

  $('save-text-btn').addEventListener('click', function () {
    var title = $('new-title').value.trim();
    var level = $('new-level').value;
    var text = $('new-text').value.trim();
    if (!title || !text) { alert('Заполните название и текст диктанта.'); return; }
    var sentences = Dictation.splitIntoSentences(text);
    if (!sentences.length) { alert('Не удалось разбить текст на предложения.'); return; }

    $('save-text-btn').disabled = true;
    db.collection('texts').add({
      title: title,
      level: level,
      sentences: sentences,
      ownerUid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      $('add-text-form').style.display = 'none';
      $('new-title').value = ''; $('new-text').value = '';
    }).catch(function (err) {
      alert('Ошибка сохранения: ' + err.message);
    }).finally(function () {
      $('save-text-btn').disabled = false;
    });
  });

  function subscribeTexts() {
    db.collection('texts').where('ownerUid', '==', currentUser.uid)
      .onSnapshot(function (snap) {
        textsCache = [];
        snap.forEach(function (doc) { textsCache.push(Object.assign({ id: doc.id }, doc.data())); });
        textsCache.sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });
        renderTextsList();
        renderSessionTextSelect();
      }, function (err) {
        $('texts-list').innerHTML = '<div class="error-banner">Не удалось загрузить библиотеку: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function renderTextsList() {
    var list = $('texts-list');
    if (!textsCache.length) {
      $('texts-empty').style.display = 'block';
      list.innerHTML = '';
      return;
    }
    $('texts-empty').style.display = 'none';
    list.innerHTML = '';
    textsCache.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML =
        '<div>' +
          '<strong>' + escapeHtml(t.title) + '</strong> ' +
          '<span class="tag">' + escapeHtml(t.level || '') + '</span> ' +
          '<span class="muted">· ' + t.sentences.length + ' предл.</span>' +
        '</div>' +
        '<div class="row" style="flex:0 0 auto; gap:8px;">' +
          '<button class="btn secondary" data-act="listen" style="padding:8px 12px;">🔊</button>' +
          '<button class="btn" data-act="session" style="padding:8px 12px;">Провести</button>' +
          '<button class="btn danger" data-act="delete" style="padding:8px 12px;">✕</button>' +
        '</div>';
      row.querySelector('[data-act="listen"]').addEventListener('click', function () {
        Dictation.speak(t.sentences[0], { rate: 0.9 });
      });
      row.querySelector('[data-act="session"]').addEventListener('click', function () {
        $('session-text-select').value = t.id;
        createSession(t);
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', function () {
        if (confirm('Удалить текст «' + t.title + '» из библиотеки?')) {
          db.collection('texts').doc(t.id).delete();
        }
      });
      list.appendChild(row);
    });
  }

  function renderSessionTextSelect() {
    var sel = $('session-text-select');
    sel.innerHTML = '';
    textsCache.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.title + ' (' + t.level + ', ' + t.sentences.length + ' предл.)';
      sel.appendChild(opt);
    });
  }

  /* ---------------- Сессия диктанта ---------------- */

  $('create-session-btn').addEventListener('click', function () {
    var id = $('session-text-select').value;
    var t = textsCache.filter(function (x) { return x.id === id; })[0];
    if (!t) { alert('Сначала добавьте текст в библиотеку.'); return; }
    createSession(t);
  });

  function createSession(text, attemptsLeft) {
    attemptsLeft = attemptsLeft === undefined ? 5 : attemptsLeft;
    var code = Dictation.generateSessionCode(6);
    var ref = db.collection('sessions').doc(code);
    ref.get().then(function (snap) {
      if (snap.exists) {
        if (attemptsLeft > 0) return createSession(text, attemptsLeft - 1);
        alert('Не удалось создать уникальный код, попробуйте ещё раз.');
        return;
      }
      return ref.set({
        ownerUid: currentUser.uid,
        textId: text.id,
        title: text.title,
        sentences: text.sentences,
        status: 'waiting',
        currentIndex: -1,
        repeatNonce: 0,
        roundStartedAt: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        openSession(code);
      });
    }).catch(function (err) { alert('Ошибка создания сессии: ' + err.message); });
  }

  function openSession(code) {
    activeSessionCode = code;
    $('session-none').style.display = 'none';
    $('session-active').style.display = 'block';

    if (unsubSession) unsubSession();
    if (unsubParticipants) unsubParticipants();

    unsubSession = db.collection('sessions').doc(code).onSnapshot(function (doc) {
      if (!doc.exists) return;
      renderSession(doc.data());
    });

    unsubParticipants = db.collection('sessions').doc(code).collection('participants')
      .onSnapshot(function (snap) {
        participantsCache = {};
        snap.forEach(function (d) { participantsCache[d.id] = d.data(); });
        renderParticipants();
      });
  }

  var lastRenderedStatus = null;

  function renderSession(session) {
    $('session-title').textContent = session.title;
    $('session-code').textContent = activeSessionCode;

    var studentUrl = studentLinkFor(activeSessionCode);
    $('session-link').textContent = studentUrl;

    var tag = $('session-status-tag');
    tag.className = 'tag status-' + (session.status === 'reveal' ? 'playing' : session.status);
    tag.textContent = session.status === 'waiting' ? 'Ожидание'
      : session.status === 'playing' ? 'Идёт диктант'
      : session.status === 'reveal' ? 'Результаты раунда'
      : 'Завершено';

    $('controls-waiting').style.display = session.status === 'waiting' ? 'block' : 'none';
    $('controls-playing').style.display = session.status === 'playing' ? 'block' : 'none';
    $('controls-reveal').style.display = session.status === 'reveal' ? 'block' : 'none';
    $('controls-finished').style.display = session.status === 'finished' ? 'block' : 'none';
    $('finish-session-btn').style.display = (session.status === 'playing' || session.status === 'reveal') ? 'block' : 'none';

    var idx = session.currentIndex;
    var total = session.sentences.length;
    if (session.status === 'playing') {
      $('sentence-progress').textContent = 'Предложение ' + (idx + 1) + ' из ' + total;
      $('current-sentence-text').textContent = session.sentences[idx] || '';
    } else if (session.status === 'reveal') {
      $('reveal-progress').textContent = 'Результаты предложения ' + (idx + 1) + ' из ' + total;
      $('next-sentence-btn').textContent = (idx >= total - 1) ? '🏁 Это последнее — завершить диктант' : '➡ Следующее предложение';
    }
    lastRenderedStatus = session.status;
    window._activeSession = session;
    renderParticipants();
  }

  function studentLinkFor(code) {
    var path = window.location.href.replace(/teacher\.html.*$/, 'student.html');
    return path + '?code=' + code;
  }

  function screenLinkFor(code) {
    var path = window.location.href.replace(/teacher\.html.*$/, 'screen.html');
    return path + '?code=' + code;
  }

  $('copy-link-btn').addEventListener('click', function () {
    var text = $('session-link').textContent;
    navigator.clipboard && navigator.clipboard.writeText(text).then(function () {
      $('copy-link-btn').textContent = 'Скопировано ✓';
      setTimeout(function () { $('copy-link-btn').textContent = 'Скопировать'; }, 1500);
    });
  });

  $('open-screen-btn').addEventListener('click', function () {
    if (!activeSessionCode) return;
    window.open(screenLinkFor(activeSessionCode), '_blank');
  });

  $('start-session-btn').addEventListener('click', function () {
    db.collection('sessions').doc(activeSessionCode).update({
      status: 'playing',
      currentIndex: 0,
      repeatNonce: 0,
      roundStartedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });

  $('repeat-sentence-btn').addEventListener('click', function () {
    db.collection('sessions').doc(activeSessionCode).update({ repeatNonce: firebase.firestore.FieldValue.increment(1) });
  });

  $('reveal-round-btn').addEventListener('click', function () {
    db.collection('sessions').doc(activeSessionCode).update({ status: 'reveal' });
  });

  $('next-sentence-btn').addEventListener('click', function () {
    var session = window._activeSession;
    if (!session) return;
    var idx = session.currentIndex;
    var total = session.sentences.length;
    if (idx >= total - 1) {
      db.collection('sessions').doc(activeSessionCode).update({ status: 'finished' });
    } else {
      db.collection('sessions').doc(activeSessionCode).update({
        currentIndex: idx + 1,
        status: 'playing',
        repeatNonce: 0,
        roundStartedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
  });

  $('finish-session-btn').addEventListener('click', function () {
    if (confirm('Завершить диктант для всех учеников сейчас?')) {
      db.collection('sessions').doc(activeSessionCode).update({ status: 'finished' });
    }
  });

  $('new-session-btn').addEventListener('click', function () {
    if (unsubSession) unsubSession();
    if (unsubParticipants) unsubParticipants();
    activeSessionCode = null;
    $('session-active').style.display = 'none';
    $('session-none').style.display = 'block';
  });

  function renderParticipants() {
    var session = window._activeSession;
    var ids = Object.keys(participantsCache);
    var list = $('participants-list');
    if (!ids.length) {
      $('participants-empty').style.display = 'block';
      list.innerHTML = '';
      if ($('answered-count')) $('answered-count').textContent = '';
      return;
    }
    $('participants-empty').style.display = 'none';
    list.innerHTML = '';
    ids.sort(function (a, b) {
      var ta = participantsCache[a].totalPoints || 0, tb = participantsCache[b].totalPoints || 0;
      if (tb !== ta) return tb - ta;
      return (participantsCache[a].name || '').localeCompare(participantsCache[b].name || '');
    }).forEach(function (id, i) {
      var p = participantsCache[id];
      var row = document.createElement('div');
      row.className = 'list-item';
      var statusHtml;
      if (p.score !== undefined && p.score !== null) {
        statusHtml = '<span class="tag status-finished">' + p.score + '%</span>';
      } else if (session && (session.status === 'playing' || session.status === 'reveal') && typeof p.lastAnsweredIndex === 'number' && p.lastAnsweredIndex >= session.currentIndex) {
        statusHtml = '<span class="tag status-playing">ответил(а) ✓</span>';
      } else if (session && session.status === 'playing') {
        statusHtml = '<span class="tag">печатает…</span>';
      } else {
        statusHtml = '<span class="tag">на диктанте</span>';
      }
      var pointsHtml = '<span class="tag">' + (p.totalPoints || 0) + ' очк.</span>';
      row.innerHTML =
        '<div><span class="rank-badge">' + (i + 1) + '</span> <strong>' + escapeHtml(p.name || 'Без имени') + '</strong></div>' +
        '<div class="row" style="flex:0 0 auto; gap:6px;">' + pointsHtml + statusHtml + '</div>';
      list.appendChild(row);
    });

    if (session && (session.status === 'playing' || session.status === 'reveal') && $('answered-count')) {
      var answered = ids.filter(function (id) {
        var p = participantsCache[id];
        return typeof p.lastAnsweredIndex === 'number' && p.lastAnsweredIndex >= session.currentIndex;
      }).length;
      $('answered-count').textContent = 'Ответили: ' + answered + ' из ' + ids.length;
    } else if ($('answered-count')) {
      $('answered-count').textContent = '';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
