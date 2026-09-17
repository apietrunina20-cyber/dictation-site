/* Общие утилиты сайта диктантов: разбиение текста на предложения,
   синтез речи, сравнение ответа ученика с оригиналом и подсчёт оценки.
   Подключается на всех страницах через <script src="js/common.js"></script>
   и доступен как глобальный объект window.Dictation */
(function (global) {
  'use strict';

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без O/0, I/1 — чтобы не путать на слух/глаз

  function generateSessionCode(length) {
    length = length || 6;
    var out = '';
    for (var i = 0; i < length; i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }

  // Список частых сокращений, после которых точка НЕ означает конец предложения.
  var ABBREVIATIONS = ['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e'];

  function splitIntoSentences(text) {
    if (!text) return [];
    var normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    var sentences = [];
    var current = '';
    var tokens = normalized.split(/(\s+)/); // сохраняем пробелы, чтобы не терять форматирование

    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      current += tok;
      var trimmedTok = tok.trim();
      if (/[.!?]["')\]]*$/.test(trimmedTok)) {
        var wordBefore = trimmedTok.replace(/[.!?"')\]]+$/, '').toLowerCase();
        var isAbbrev = ABBREVIATIONS.indexOf(wordBefore) !== -1 || /^[a-zA-Z]$/.test(wordBefore);
        var isDecimalNumber = /^\d+$/.test(wordBefore) && /^\d/.test((tokens[i + 2] || ''));
        if (!isAbbrev && !isDecimalNumber) {
          var trimmedCurrent = current.trim();
          if (trimmedCurrent) sentences.push(trimmedCurrent);
          current = '';
        }
      }
    }
    var rest = current.trim();
    if (rest) sentences.push(rest);
    return sentences.filter(function (s) { return s.length > 0; });
  }

  function normalizeWord(w) {
    return w.toLowerCase().replace(/^[^a-zA-Zа-яА-ЯёЁ0-9']+|[^a-zA-Zа-яА-ЯёЁ0-9']+$/g, '');
  }

  function tokenizeWords(text) {
    return (text.match(/[\p{L}\p{N}']+/gu) || []);
  }

  // Пословное сравнение оригинального предложения и ответа ученика через LCS.
  // Возвращает массив токенов { text, type } где type: 'correct' | 'wrong' | 'missing' | 'extra'
  // и статистику { correctCount, totalOriginal }.
  function diffSentence(originalSentence, studentAnswer) {
    var origWords = tokenizeWords(originalSentence || '');
    var ansWords = tokenizeWords(studentAnswer || '');
    var origNorm = origWords.map(normalizeWord);
    var ansNorm = ansWords.map(normalizeWord);

    var n = origNorm.length, m = ansNorm.length;
    var dp = [];
    for (var i = 0; i <= n; i++) {
      dp.push(new Array(m + 1).fill(0));
    }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        if (origNorm[i] && origNorm[i] === ansNorm[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    var tokens = [];
    var correctCount = 0;
    i = 0; var jj = 0;
    while (i < n && jj < m) {
      if (origNorm[i] === ansNorm[jj]) {
        tokens.push({ text: origWords[i], type: 'correct' });
        correctCount++;
        i++; jj++;
      } else if (dp[i + 1][jj] >= dp[i][jj + 1]) {
        tokens.push({ text: origWords[i], type: 'missing' });
        i++;
      } else {
        tokens.push({ text: ansWords[jj], type: 'extra' });
        jj++;
      }
    }
    while (i < n) { tokens.push({ text: origWords[i], type: 'missing' }); i++; }
    while (jj < m) { tokens.push({ text: ansWords[jj], type: 'extra' }); jj++; }

    return { tokens: tokens, correctCount: correctCount, totalOriginal: origWords.length };
  }

  function scoreDictation(originalSentences, answers) {
    var totalWords = 0, totalCorrect = 0;
    var perSentence = originalSentences.map(function (s, idx) {
      var d = diffSentence(s, answers[idx] || '');
      totalWords += d.totalOriginal;
      totalCorrect += d.correctCount;
      return d;
    });
    var percent = totalWords > 0 ? Math.round((totalCorrect / totalWords) * 100) : 0;
    return { perSentence: perSentence, totalWords: totalWords, totalCorrect: totalCorrect, percent: percent };
  }

  /* ---------- Синтез речи (Web Speech API) ---------- */

  var currentUtterance = null;

  function getEnglishVoices() {
    var voices = global.speechSynthesis ? global.speechSynthesis.getVoices() : [];
    var en = voices.filter(function (v) { return /^en/i.test(v.lang); });
    return en.length ? en : voices;
  }

  function speak(text, opts) {
    opts = opts || {};
    if (!global.speechSynthesis) {
      if (opts.onerror) opts.onerror(new Error('speechSynthesis не поддерживается в этом браузере'));
      return;
    }
    global.speechSynthesis.cancel();
    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = opts.lang || 'en-US';
    utter.rate = opts.rate || 0.9;
    if (opts.voiceURI) {
      var voice = global.speechSynthesis.getVoices().filter(function (v) { return v.voiceURI === opts.voiceURI; })[0];
      if (voice) utter.voice = voice;
    }
    if (opts.onend) utter.onend = opts.onend;
    if (opts.onerror) utter.onerror = opts.onerror;
    currentUtterance = utter;
    global.speechSynthesis.speak(utter);
  }

  function cancelSpeech() {
    if (global.speechSynthesis) global.speechSynthesis.cancel();
  }

  /* ---------- localStorage: постоянный ID участника на устройстве ---------- */

  function getParticipantId(sessionCode) {
    var key = 'dictation_pid_' + sessionCode;
    var id = null;
    try { id = localStorage.getItem(key); } catch (e) {}
    if (!id) {
      id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(key, id); } catch (e) {}
    }
    return id;
  }

  global.Dictation = {
    generateSessionCode: generateSessionCode,
    splitIntoSentences: splitIntoSentences,
    diffSentence: diffSentence,
    scoreDictation: scoreDictation,
    getEnglishVoices: getEnglishVoices,
    speak: speak,
    cancelSpeech: cancelSpeech,
    getParticipantId: getParticipantId
  };
})(window);

