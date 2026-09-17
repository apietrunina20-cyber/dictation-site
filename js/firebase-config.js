/* Конфигурация проекта Firebase (dictations-anastasia). */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyC11lFqr5HlpC1nm-PfkLPfwiHdDZmYDFk",
  authDomain: "dictations-anastasia.firebaseapp.com",
  projectId: "dictations-anastasia",
  storageBucket: "dictations-anastasia.firebasestorage.app",
  messagingSenderId: "1011751134883",
  appId: "1:1011751134883:web:d1748c557ea188813ac116"
};

window.FIREBASE_CONFIG_IS_SET = function () {
  var c = window.FIREBASE_CONFIG;
  return c && c.apiKey && c.apiKey.indexOf('ВАШ_') === -1 && c.projectId && c.projectId.indexOf('ВАШ_') === -1;
};

