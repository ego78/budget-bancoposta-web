if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('./sw.js'));
const modal=document.querySelector('#modal'),s1=document.querySelector('#step1'),s2=document.querySelector('#step2');
let leftForLogin=false;
function openM(){modal.hidden=false;document.body.style.overflow='hidden';s1.hidden=false;s2.hidden=true}
function closeM(){modal.hidden=true;document.body.style.overflow=''}
document.querySelector('#openLogin').onclick=openM;document.querySelector('#x').onclick=closeM;
document.querySelector('#externalLogin').addEventListener('click',()=>{leftForLogin=true;localStorage.setItem('mensaAuthAttempt','1')});
function returned(){if(leftForLogin||localStorage.getItem('mensaAuthAttempt')==='1'){if(!modal.hidden){s1.hidden=true;s2.hidden=false}}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)returned()});addEventListener('pageshow',returned);
document.querySelector('#done').onclick=()=>{localStorage.removeItem('mensaAuthAttempt');leftForLogin=false;closeM()};
document.querySelector('#again').onclick=()=>{window.open('https://www.comune.sava.ta.it/mensascolastica','_blank');leftForLogin=true};
