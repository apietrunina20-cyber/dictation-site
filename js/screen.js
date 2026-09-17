/* Общий экран для проектора: показывает лобби, ход раунда (без текста
   предложения — чтобы не подсказывать ученикам) и рейтинг между раундами,
   а в конце — итоговый рейтинг/подиум. Публичная read-only страница,
   ничего не пишет в базу. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  if (!window.FIREBASE_CONFIG_IS_SET || !window.FIREBASE_CONFIG_IS_SET()) {
    $('view-setup').style.display = 'block';
    return;
  }

  var params = new URLSearchParams(window.location.search);
  var code = (params.get('code') || '').toUpperCase();
  if (!code) {
    $('view-nocode').style.display = 'block';
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  var db = firebase.firestore();

  var session = null;
  var participantsCache = {};

  db.collection('sessions').doc(code).onSnapshot(function (doc) {
    if (!doc.exists) {
      $('view-nocode').style.display = 'block';
      return;
    }
    session = doc.data();
    render();
  }, function () {
    $('view-nocode').style.display = 'block';
  });

  db.collection('sessions').doc(code).collection('participants').onSnapshot(function (snap) {
    participantsCache = {};
    snap.forEach(function (d) { participantsCache[d.id] = d.data(); });
    render();
  });

  function render() {
    if (!session) return;
    var view = session.status === 'waiting' ? 'view-lobby'
      : session.status === 'playing' ? 'view-round'
      : session.status === 'reveal' ? 'view-round-reveal'
      : 'view-final';
    showView(view);
    if (session.status === 'waiting') renderLobby();
    else if (session.status === 'playing') renderRound();
    else if (session.status === 'reveal') renderReveal();
    else renderFinal();
  }

  function showView(id) {
    ['view-lobby', 'view-round', 'view-round-reveal', 'view-final'].forEach(function (v) {
      $(v).style.display = v === id ? 'block' : 'none';
    });
  }

  function sortedParticipants() {
    return Object.keys(participantsCache).map(function (id) {
      return Object.assign({ id: id }, participantsCache[id]);
    }).sort(function (a, b) {
      var ta = a.totalPoints || 0, tb = b.totalPoints || 0;
      if (tb !== ta) return tb - ta;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  function renderLobby() {
    $('lobby-title').textContent = session.title;
    $('lobby-code').textContent = code;
    var list = sortedParticipants();
    $('lobby-count').textContent = list.length;
    $('lobby-participants').innerHTML = list.map(function (p) {
      return '<span class="chip">' + escapeHtml(p.name || '?') + '</span>';
    }).join('');
  }

  function renderRound() {
    var idx = session.currentIndex, total = session.sentences.length;
    $('round-progress').textContent = 'Предложение ' + (idx + 1) + ' из ' + total;
    var list = sortedParticipants();
    var answered = list.filter(function (p) {
      return typeof p.lastAnsweredIndex === 'number' && p.lastAnsweredIndex >= idx;
    }).length;
    $('round-answered').textContent = 'Ответили: ' + answered + ' из ' + list.length;
  }

  function renderReveal() {
    var idx = session.currentIndex, total = session.sentences.length;
    $('reveal-progress-screen').textContent = 'Результаты предложения ' + (idx + 1) + ' из ' + total;
    $('reveal-sentence-text').textContent = session.sentences[idx];
    $('reveal-leaderboard').innerHTML = leaderboardHtml(sortedParticipants());
  }

  function renderFinal() {
    var list = sortedParticipants();
    var top3 = list.slice(0, 3);
    var medals = ['🥇', '🥈', '🥉'];
    $('final-podium').innerHTML = top3.map(function (p, i) {
      return '<div class="podium-slot podium-' + (i + 1) + '">' +
        '<div class="podium-medal">' + medals[i] + '</div>' +
        '<div class="podium-name">' + escapeHtml(p.name || '?') + '</div>' +
        '<div class="podium-points">' + (p.totalPoints || 0) + ' очк.</div>' +
      '</div>';
    }).join('');
    $('final-leaderboard').innerHTML = leaderboardHtml(list.slice(3), 4);
  }

  function leaderboardHtml(list, startRank) {
    startRank = startRank || 1;
    return list.map(function (p, i) {
      return '<div class="list-item"><div><span class="rank-badge">' + (startRank + i) + '</span> <strong>' +
        escapeHtml(p.name || '?') + '</strong></div><span class="tag">' + (p.totalPoints || 0) + ' очк.</span></div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
