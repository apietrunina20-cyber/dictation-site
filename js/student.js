(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  if (!window.FIREBASE_CONFIG_IS_SET || !window.FIREBASE_CONFIG_IS_SET()) {
    $('view-setup').style.display = 'block';
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  var db = firebase.firestore();

  var sessionCode = null;
  var participantId = null;
  var session = null;
  var answers = [];
  var lastHandledIndex = -1;
  var lastHandledNonce = null;
  var finishedHandled = false;
  var rate = parseFloat(localStorage.getItem('dictation_rate') || '0.9');
  var chosenVoiceURI = localStorage.getItem('dictation_voice') || '';

  showView('view-join');

  var params = new URLSearchParams(window.location.search);
  if (params.get('code')) $('join-code').value = params.get('code').toUpperCase();

  $('join-code').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
  });

  $('join-btn').addEventListener('click', function () {
    var code = $('join-code').value.trim().toUpperCase();
    var name = $('join-name').value.trim();
    $('join-error').style.display = 'none';
    if (!code || !name) {
      showJoinError('Заполни код и имя.');
      return;
    }
    $('join-btn').disabled = true;
    db.collection('sessions').doc(code).get().then(function (doc) {
      if (!doc.exists) {
        showJoinError('Диктант с таким кодом не найден. Проверь код у учителя.');
        $('join-btn').disabled = false;
        return;
      }
      sessionCode = code;
      $('footer-code').textContent = 'Код диктанта: ' + code;
      participantId = Dictation.getParticipantId(code);
      var pRef = db.collection('sessions').doc(code).collection('participants').doc(participantId);
      pRef.get().then(function (pDoc) {
        var setup = pDoc.exists ? Promise.resolve() : pRef.set({ name: name, joinedAt: firebase.firestore.FieldValue.serverTimestamp() });
        Promise.resolve(setup).then(function () {
          if (pDoc.exists && pDoc.data().score !== undefined && pDoc.data().score !== null) {
            // Уже проходил(а) этот диктант — сразу показываем результат.
            db.collection('sessions').doc(code).get().then(function (sDoc) {
              showStoredResult(sDoc.data(), pDoc.data());
            });
          } else {
            listenToSession(code);
          }
        });
      });
    }).catch(function (err) {
      showJoinError('Ошибка: ' + err.message);
      $('join-btn').disabled = false;
    });
  });

  function showJoinError(msg) {
    $('join-error').textContent = msg;
    $('join-error').style.display = 'block';
  }

  function listenToSession(code) {
    db.collection('sessions').doc(code).onSnapshot(function (doc) {
      if (!doc.exists) return;
      session = doc.data();
      handleSessionUpdate();
    });
  }

  function handleSessionUpdate() {
    if (session.status === 'waiting') {
      showView('view-waiting');
      $('waiting-title').textContent = session.title;
    } else if (session.status === 'playing') {
      showView('view-dictation');
      $('dictation-title').textContent = session.title;
      var idx = session.currentIndex;
      var total = session.sentences.length;
      $('sentence-progress').textContent = 'Предложение ' + (idx + 1) + ' из ' + total;

      if (idx !== lastHandledIndex) {
        if (lastHandledIndex >= 0) {
          answers[lastHandledIndex] = $('current-answer').value;
          appendCompletedLine(answers[lastHandledIndex]);
        }
        lastHandledIndex = idx;
        lastHandledNonce = session.repeatNonce;
        $('current-answer').value = '';
        $('current-answer').focus();
        speakCurrent();
      } else if (session.repeatNonce !== lastHandledNonce) {
        lastHandledNonce = session.repeatNonce;
        speakCurrent();
      }
    } else if (session.status === 'finished') {
      if (!finishedHandled) {
        finishedHandled = true;
        if (lastHandledIndex >= 0 && answers[lastHandledIndex] === undefined) {
          answers[lastHandledIndex] = $('current-answer').value;
          appendCompletedLine(answers[lastHandledIndex]);
        }
        Dictation.cancelSpeech();
        var score = Dictation.scoreDictation(session.sentences, answers);
        db.collection('sessions').doc(sessionCode).collection('participants').doc(participantId).set({
          answers: answers,
          score: score.percent,
          totalWords: score.totalWords,
          totalCorrect: score.totalCorrect,
          finishedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        renderResults(session.sentences, score);
      }
    }
  }

  function showStoredResult(sessionData, participantData) {
    var answersStored = participantData.answers || [];
    var score = Dictation.scoreDictation(sessionData.sentences, answersStored);
    renderResults(sessionData.sentences, score);
  }

  function appendCompletedLine(text) {
    var div = $('completed-lines');
    div.textContent = (div.textContent ? div.textContent + '\n' : '') + (text || '');
  }

  function speakCurrent() {
    if (!session) return;
    var text = session.sentences[lastHandledIndex];
    $('speaker-icon').style.opacity = '1';
    Dictation.speak(text, {
      rate: rate,
      voiceURI: chosenVoiceURI || undefined,
      onend: function () { $('speaker-icon').style.opacity = '0.4'; }
    });
  }

  $('replay-btn').addEventListener('click', function () { speakCurrent(); });

  /* ---------- Настройки голоса ---------- */

  $('settings-toggle').addEventListener('click', function () {
    var panel = $('settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  function populateVoices() {
    var voices = Dictation.getEnglishVoices();
    var sel = $('voice-select');
    sel.innerHTML = '';
    voices.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = v.name + ' (' + v.lang + ')';
      if (v.voiceURI === chosenVoiceURI) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  if (window.speechSynthesis) {
    populateVoices();
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }
  $('voice-select').addEventListener('change', function () {
    chosenVoiceURI = this.value;
    localStorage.setItem('dictation_voice', chosenVoiceURI);
  });
  $('rate-range').value = rate;
  $('rate-value').textContent = rate;
  $('rate-range').addEventListener('input', function () {
    rate = parseFloat(this.value);
    $('rate-value').textContent = rate.toFixed(1);
    localStorage.setItem('dictation_rate', rate);
  });

  /* ---------- Результаты ---------- */

  function renderResults(sentences, score) {
    showView('view-results');
    $('score-badge').textContent = score.percent + '%';
    $('score-summary').textContent = score.totalCorrect + ' из ' + score.totalWords + ' слов совпадают с оригиналом.';
    var list = $('results-list');
    list.innerHTML = '';
    score.perSentence.forEach(function (d, idx) {
      var div = document.createElement('div');
      div.className = 'diff-sentence';
      var html = '<span class="num">' + (idx + 1) + '.</span>';
      d.tokens.forEach(function (tok) {
        var cls = tok.type === 'correct' ? 'tok-correct' : tok.type === 'missing' ? 'tok-missing' : 'tok-extra';
        html += '<span class="' + cls + '">' + escapeHtml(tok.text) + '</span> ';
      });
      div.innerHTML = html;
      list.appendChild(div);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showView(id) {
    ['view-join', 'view-waiting', 'view-dictation', 'view-results'].forEach(function (v) {
      $(v).style.display = v === id ? 'block' : 'none';
    });
  }
})();

