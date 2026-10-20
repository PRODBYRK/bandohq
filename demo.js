/* BANDOHQ · demodata
   Påhittat crew, cirklar, kunder, pass, beats och galleri. Används av
   · test/shot.html (skärmdumpar och App Store-bilderna)
   · demoläget i appen — det App Store-granskningen loggar in i (användarnamn apple-review),
     så att granskaren ser allt utan att komma åt riktiga personers uppgifter.
   bandohqDemo({who, gate, leads, dbx, join, jrole}) → appens sparade läge (S). */
window.bandohqDemo = function(o){
  o = o || {};
  const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
  const A=(id,n,r,c,g,email,phone)=>({id,n,r,c,g,email:email||'',phone:phone||'',
    pinHash:'x',pinSalt:'s',active:true,del:false,up:1});
  /* Bando HQ Access: inriktningar, godkännande och personnummer (bara det maskerade — påhittat) */
  const ACC=(a,ints,pnr,reg,src)=>Object.assign(a,{part:true,interests:ints,consent:true,pnr,reg:reg?D(reg)+'T12:00:00Z':'',source:src||''});
  const accounts=[
    A('az','AZ','manager','#cbd5e1','#f1f5f9','az@bandocollective.com'),
    A('rkay','RKAY','producer','#7c3aed','#a855f7','rkay@bandocollective.com'),
    A('adrey','ADREY','producer','#0284c7','#38bdf8','adrey@bandocollective.com'),
    A('v2k','V2K','producer','#d97706','#fbbf24','v2k@bandocollective.com'),
    A('gio','GIOVANNI','producer','#db2777','#f472b6','gio@bandocollective.com'),
    A('pkl','PKL','producer','#047857','#34d399','pkl@bandocollective.com'),
    A('lead1','Sofia Marks','leader','#6633b8','#9d5cf5','sofia@exempel.se','070-555 11 22'),
    ACC(A('p1','William Ek','participant','#6633b8','#9d5cf5','william@exempel.se','070-000 01'),['production','mixing'],'040212-••••'),
    ACC(A('p2','Nora Lind','participant','#6633b8','#9d5cf5','nora@exempel.se','070-000 02'),['vocals','songwriting'],'050830-••••'),
    ACC(A('p3','Sam Ahmed','participant','#6633b8','#9d5cf5','sam@exempel.se','070-000 03'),['rap','artistdev'],'031119-••••'),
    ACC(A('p4','Ida Berg','participant','#6633b8','#9d5cf5','ida@exempel.se','070-000 04'),['performance','vocals'],'060104-••••'),
    ACC(Object.assign(A('k1','Studio Nord AB','customer','#0284c7','#38bdf8','bokning@studionord.se','070-123 45 67'),{producer:'rkay',producers:['rkay','adrey']}),['production','mixing'],'900412-••••',-40,'access'),
    /* ny via QR-koden i går — väntar på en grupp */
    /* värvad av Studio Nord (värva en vän) */
    Object.assign(ACC(A('k2','Lea Novak','customer','#db2777','#f472b6','lea.novak@exempel.se','073-456 78 90'),['vocals','artistdev','content'],'020317-••••',-1,'access'),{referredBy:'k1'}),
    /* v8: admins och kamerateam */
    A('costa','Costa','admin','#7c3aed','#a855f7','costa@bandocollective.com','070-200 00 01'),
    A('nabbe','Nabbe','admin','#0284c7','#38bdf8','nabbe@bandocollective.com','070-200 00 02'),
    Object.assign(A('moez','Moez','camera','#d97706','#fbbf24','moez@bandocollective.com','070-200 00 03'),{team:'Moez',ig:'moez'}),
    Object.assign(A('d2la','Alva','camera','#db2777','#f472b6','alva@d2l.se','070-200 00 04'),{team:'D2L',ig:'d2l.film'}),
    Object.assign(A('d2lb','Benji','camera','#db2777','#f472b6','benji@d2l.se','070-200 00 05'),{team:'D2L',ig:'d2l.film'})
  ];
  const curricula=[
   {id:'cu1',subject:'Musikproduktion',title:'Aktuell läroplan – Musikproduktion',
    body:'Produktion\nArrangemang\nInspelning\nMix\nFärdigställa musik',from:'2026-09-01',del:false,up:1},
   {id:'cu2',subject:'Artistutveckling',title:'Aktuell läroplan – Artistutveckling',
    body:'Eget uttryck\nLåtskrivning\nScennärvaro\nSläppa musik',from:'2026-09-01',del:false,up:1}];
  const circles=[
   {id:'c1',n:'Musikproduktion – Grupp 1',subject:'Musikproduktion',leader:'RKAY',curriculumId:'cu1',courseId:'kmp',courseSince:D(-15),
    members:['p1','p2','p3'],active:true,del:false,up:1},
   {id:'c2',n:'Artistutveckling – Grupp 2',subject:'Artistutveckling',leader:'Sofia Marks',curriculumId:'cu2',courseId:'kau',courseSince:D(-15),
    members:['p1','p4'],active:true,del:false,up:1}];
  /* utbildningssystemet: två kurser (förkortade — hela startinnehållet ligger i kurser.js) */
  const LS = (p, t) => t.map((x,i)=>({id:p+i, title:x[0], content:x[1], goals:x[2], exercises:x[3]}));
  const courses=[
   {id:'kmp',subject:'Musikproduktion',draft:false,del:false,up:1,levels:[
     {title:'Nivå 1 · Grunder',lessons:LS('mp1',[
       ['Studion och DAW:en','Projekt, spår, tempo och export.','Kunna starta ett projekt\nKänna till signalvägen','Spela in åtta takter och exportera.'],
       ['Trummor och groove','Kick, virvel, hihat, kvantisering och swing.','Programmera ett komp','Gör tre komp i samma tempo.'],
       ['Harmonik och ackord','Tonarter, ackordföljder och basgång.','Bygga en ackordföljd','Skriv en följd och en basgång.']])},
     {title:'Nivå 2 · Fördjupning',lessons:LS('mp2',[
       ['Inspelning av sång','Mikrofon, avstånd och nivåer.','Ställa in en sånginspelning','Spela in en vers i tre tagningar.'],
       ['Mix: balans','Nivåer, panorering och mono.','Göra en grovmix','Mixa utan plugins.']])}]},
   {id:'kau',subject:'Artistutveckling',draft:false,del:false,up:1,levels:[
     {title:'Nivå 1 · Grunder',lessons:LS('au1',[
       ['Vem är du som artist?','Uttryck och förebilder.','Beskriva sitt uttryck','Skriv tre meningar om din musik.'],
       ['Låtskrivande: idé och hook','Titel, hook och känsla.','Skriva en hook','Skriv fem hookar till samma beat.'],
       ['Text och berättande','Bilder och detaljer.','Skriva konkreta rader','Skriv om en vers.']])}]}];
  const bookings=[];
  /* v5-demo: påhittade artister — de riktiga läggs in när det är klart vem som är vad */
  const artists=[
    {id:'ar1',n:'Nova',priority:1,genre:'R&B',ig:'novamusic',note:'EP i december — vocals klara, mix kvar',active:true,del:false,up:1},
    {id:'ar2',n:'Kairo',priority:1,genre:'Drill',note:'Två singlar på gång',active:true,del:false,up:1},
    {id:'ar3',n:'Lizzie',priority:2,genre:'Pop',note:'',active:true,del:false,up:1},
    {id:'ar4',n:'Sami B',priority:3,genre:'Hiphop',note:'Avvaktar',active:true,del:false,up:1}];
  const WITH = [['ADREY'],['V2K'],[],['PKL'],['ADREY','GIOVANNI'],[],['V2K']];
  const ART  = ['ar1','ar2','ar1','ar3','ar2','','ar1'];
  let wi = 0;
  const B=(id,st,d,a,b,who,t,cid,status,hours,present,paid,reqBy)=>bookings.push({
    /* kundpass har varken medproducenter eller artist — formuläret visar inte ens fälten */
    with: (cid || paid) ? [] : WITH[wi%7].filter(n=>n!==who), artistId: (cid || paid) ? '' : ART[(wi++)%7],
    id,studio:st,date:d,
    start:a,end:b,who,title:t,note:'',circleId:cid||'',status:status||'',
    hours:hours==null?null:hours,present:present||[],completedBy:status==='done'?who:'',
    reqBy:reqBy||'',up:Date.now()-1e5,del:false,paid:!!paid});
  B('k1b','A',D(0),'14:00','17:00','ADREY','Vocals — Nova','','',null,[],true);
  B('k2b','B',D(1),'19:00','22:00','Studio Nord AB','Studiotid','','',null,[],true);
  B('k0b','A',D(-6),'14:00','17:00','Studio Nord AB','Studiotid','','',null,[],true);
  Object.assign(bookings[bookings.length-1], {closed:true, closedBy:'RKAY', closedAt:Date.now()-5*864e5});
  let n=0;
  for(let w=1;w<=14;w++){
    B('g'+(n++),'A',D(-7*w),'18:00','21:00','RKAY','Musikproduktion – Grupp 1','c1','done',3,['p1','p2','p3']);
    if(w%2) B('g'+(n++),'B',D(-7*w+1),'17:00','20:00','Sofia Marks','Artistutveckling – Grupp 2','c2','done',3,['p1','p4']);
  }
  /* de första passen har gått igenom kursens första lektioner */
  const doneIn = cid => bookings.filter(b=>b.circleId===cid && b.status==='done' && b.date>=D(-15)).sort((a,b)=>a.date<b.date?-1:1);
  doneIn('c1').slice(0,2).forEach((b,i)=>Object.assign(b, {lessonId:'mp1'+i, lessonTitle:courses[0].levels[0].lessons[i].title}));
  doneIn('c2').slice(0,1).forEach(b=>Object.assign(b, {lessonId:'au10', lessonTitle:courses[1].levels[0].lessons[0].title}));
  B('u1','A',D(3),'18:00','21:00','RKAY','Musikproduktion – Grupp 1','c1');
  const PR=['RKAY','ADREY','V2K','GIOVANNI','PKL'];
  for(let i=1;i<=40;i++) B('cp'+i, i%2?'A':'B', D(-i-1), i%3?'13:00':'10:00', i%3?'16:00':'13:00', PR[i%5], 'Session');
  B('r1','',D(6),'18:00','21:00','Sofia Marks','Artistutveckling – Grupp 2','c2','request',null,[],false,'p1');
  B('r2','',D(8),'17:00','20:00','Sofia Marks','Artistutveckling – Grupp 2','c2','request',null,[],false,'p4');
  B('kr1','',D(2),'12:00','15:00','Studio Nord AB','Studiotid','','request',null,[],true,'k1');
  /* veckoplanen: några pass i veckan markerade som körda */
  bookings.filter(b=>!b.circleId && !b.paid && b.date<D(0)).slice(0,6).forEach((b,i)=>{ if(i%3) b.ran = true; });
  const MEDIA = [['Nova studio 01.jpg','Moez','moez','ar1'],['Nova studio 02.jpg','Moez','moez','ar1'],['BTS mixdown.mov','D2L','d2la',''],
    ['Kairo cover.jpg','D2L','d2lb','ar2'],['Kairo video.mp4','D2L','d2la','ar2'],['Studio B kväll.jpg','Moez','moez',''],
    ['Lizzie live.jpg','Moez','moez','ar3'],['Crew porträtt.jpg','D2L','d2lb','']];

  const who = o.who||'AZ';
  const S = {v:2, session: o.gate ? null
      : {email:'',name:who,picture:'',member:who,ts:Date.now(),via:'pin'},
    accounts, studios:{A:'STUDIO A',B:'THE BOOTH'}, bookings, files:[],
    circles, curricula, artists,
    releases:[
      {id:'rl1',artistId:'ar1',title:'Midnatt',date:D(-60),streams:412300,producers:['RKAY','ADREY'],link:'',del:false,up:1},
      {id:'rl2',artistId:'ar1',title:'Kall',date:D(-20),streams:96800,producers:['RKAY'],link:'',del:false,up:1},
      {id:'rl3',artistId:'ar2',title:'Blocket',date:D(-35),streams:1240000,producers:['V2K','PKL'],link:'',del:false,up:1},
      {id:'rl4',artistId:'ar3',title:'Sommar igen',date:D(-90),streams:58200,producers:['GIOVANNI'],link:'',del:false,up:1}],
    beats:[
      ['Moonlight','RKAY','140','Cm','ny',''],['Kall natt','RKAY','92','F#m','skickad','ar1'],
      ['Drillbox 4','V2K','142','Gm','placerad','ar2'],['Sommarljus','GIOVANNI','104','A','ny',''],
      ['Bounce','PKL','98','Dm','skickad','ar2'],['Velvet','ADREY','86','Ebm','ny',''],
      ['Grind','V2K','150','Bbm','ny',''],['Slow burn','RKAY','78','Am','placerad','ar1']
    ].map((x,i)=>({id:'bt'+i,name:x[0],who:x[1],bpm:x[2],key:x[3],status:x[4],artistId:x[5],
      file:x[0]+'.wav',fileId:'id:mock'+(100+i),path:'/BANDOHQ/Beats/'+x[1]+'/'+x[0]+'.wav',size:42e6,
      added:new Date(Date.now()-i*2*864e5).toISOString(),del:false,up:1})),
    agenda:[
      ['week','RKAY','Mixa Nova-EP:n',true],['week','RKAY','Skicka stems till Kairo',false],
      ['week','ADREY','Vocalsession med Nova',true],['week','ADREY','Comp och tune',false],
      ['week','V2K','3 nya drillbeats',false],['week','PKL','Bounce till Kairo',true],
      ['week','GIOVANNI','Rensa beatmappen',false],['week','','Städa studio B',false]
    ].map((x,i)=>({id:'ag'+i,kind:x[0],week:x[0]==='week'?(()=>{const d=new Date();const w=(d.getDay()+6)%7;d.setDate(d.getDate()-w);
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})():'',
      who:x[1],text:x[2],done:x[3],due:'',del:false,up:1})).concat([
      /* allmänna agendan: gemensam för hela teamet, utan ägare (by = vem som skrev punkten) */
      ['projekt','Släppa Novas EP innan jul','Release, video och content i samma veckor.',D(60),'az'],
      ['projekt','Bygga ett eget releasebolag inom Bando','',D(300),'az'],
      ['ambition','Fem placeringar hos större artister under Q4','',D(75),'rkay'],
      ['ambition','Bli Stockholms självklara studio för nya artister','','','az'],
      ['utveckling','Starkare content och visuals runt varje släpp','Kamerateamet med från första sessionen.','','moez'],
      ['utveckling','Tydligare uppföljning av artisterna efter passen','','','costa'],
      ['mojlighet','Sync i reklam och tv — håll utkik efter briefar','Tipsa här så fort något dyker upp.','','adrey'],
      ['mojlighet','Samarbeten med festivaler i sommar','','','v2k']
    ].map((x,i)=>({id:'ga'+i,kind:'general',cat:x[0],week:'',who:'',text:x[1],note:x[2],due:x[3],by:x[4],done:false,del:false,up:1}))),
    media: MEDIA.map((x,i)=>({id:'md'+i, by:x[2], team:x[1], name:x[0].replace(/\.[^.]+$/,''), file:x[0], fileId:'id:mock'+(300+i),
      path:'/BANDOHQ/Media/'+x[1]+'/'+x[0], type:/\.(mov|mp4)$/.test(x[0])?'video':'image', size:3e6,
      added:new Date(Date.now()-i*864e5).toISOString(), caption:'', artistId:x[3], posted:i===1?{rkay:1}:{}, del:false, up:1})),
    leads: o.leads ? [{id:'l_demo', name:'Vera Ny', email:'vera@exempel.se', phone:'+46731112233', date:D(4), start_t:'12:00', end_t:'16:00',
      studio:'A', message:'EP-inspelning, vi är tre', status:'new', created_at:new Date().toISOString()}] : [],
    seed8:1,
    goals:[
      {id:'go1',owner:'rkay',text:'Placera 3 beats hos Nova innan december',due:D(60),status:'aktiv',del:false,up:1},
      {id:'go2',owner:'rkay',text:'Lära mig mixa vocals själv',due:'',status:'aktiv',cat:'utveckling',del:false,up:1},
      {id:'go6',owner:'rkay',text:'Producera för en artist på topplistan',due:'',status:'aktiv',cat:'ambition',del:false,up:1},
      {id:'go3',owner:'rkay',text:'Första släppet med Kairo',due:D(-10),status:'klar',del:false,up:1},
      {id:'go4',owner:'adrey',text:'Bli bäst på vocalproduktion i crewet',due:'',status:'aktiv',cat:'ambition',del:false,up:1},
      {id:'go5',owner:'v2k',text:'Beatpack på 20 beats',due:D(-3),status:'aktiv',del:false,up:1}],
    plans:[{id:'rkay',text:'Två beats i veckan till Nova.\nEn mixsession med ADREY varje torsdag.\nFråga Kairo om en sommarsingel.',del:false,up:1}],
    /* dbx=1 → Dropbox kopplat och uppsatt (mock-läget svarar i stället för Dropbox) */
    dropbox: o.dbx ? {appKey:'mockappkey1', sharedId:'sf1', setupAt:Date.now(), up:1}
      : {appKey:'', sharedId:'', setupAt:0, up:0},
    invites: (o.join ? [{token:o.join, role:o.jrole||'participant', circle_id:o.jrole==='producer'?null:'c1',
      expires_at:Date.now()+7*864e5, max_uses:null, uses:2, closed:false, created:Date.now()}] : [])
      /* Studio Nord har bjudit in en vän till (väntar) och Lea (har gått med) */
      .concat([{token:'DEMO-F00001', role:'customer', circle_id:null, expires_at:Date.now()+26*864e5, max_uses:1, uses:0, closed:false,
        created:Date.now()-4*864e5, created_by:'k1', referrer:'k1', name:'Elsa Holm', email:'elsa.holm@exempel.se', phone:'', interests:[]},
        {token:'DEMO-F00002', role:'customer', circle_id:null, expires_at:Date.now()+29*864e5, max_uses:1, uses:1, closed:false,
        created:Date.now()-2*864e5, created_by:'k1', referrer:'k1', name:'Lea Novak', email:'lea.novak@exempel.se', phone:'', interests:[]}]),
    courses,
    /* Bando Rewards (förhandslägets "server", se rwLocal i index.html) */
    rw:{seq:20, levelHist:[], redemptions:[],
      levels:[{id:'lv_member',name:'Member',rank:0,criteria:{},perks:'',active:true},{id:'lv_silver',name:'Silver',rank:1,criteria:{minEarned:1000},perks:'10 % rabatt på studiotid',active:true},
              {id:'lv_gold',name:'Gold',rank:2,criteria:{minEarned:3000,minSessions12:10},perks:'',active:true},{id:'lv_platinum',name:'Platinum',rank:3,criteria:{minEarned:6000,minSessions12:20},perks:'',active:true}],
      rewards:[{id:'rw1',title:'Bando-hoodie',description:'Hämtas i studion',cost:500,active:true},{id:'rw2',title:'Gratis mixpass',description:'3 timmar med en producent',cost:2000,active:true}],
      points:[{id:1,member_id:'k1',booking_id:'k0b',kind:'earn',points:100,note:'Studiotid',by_id:'rkay',at:new Date(Date.now()-5*864e5).toISOString()},
              {id:2,member_id:'k1',kind:'bonus',points:100,note:'Välkomstbonus',ref:'welcome',by_id:'k1',at:new Date(Date.now()-40*864e5).toISOString()},
              {id:4,member_id:'k1',booking_id:'k0b',kind:'bonus',points:200,note:'Första sessionen',ref:'first',by_id:'rkay',at:new Date(Date.now()-5*864e5).toISOString()},
              {id:5,member_id:'k2',kind:'bonus',points:100,note:'Välkomstbonus',ref:'welcome',by_id:'k2',at:new Date(Date.now()-1*864e5).toISOString()}],
      notes:[{id:3,member_id:'k1',booking_id:'k0b',author_id:'rkay',created_at:new Date(Date.now()-5*864e5).toISOString(),went:'Fokuserad session — två tagningar räckte',
              created:'Vers 1 och refrängen',strengths:'Melodier och röstkontroll',develop:'Detaljer i texten',next:'Mixa refrängen och spela in vers 2',other:''}],
      crm:{k1:{projects:'EP till våren',goals:'Första egna spelningen',followup:D(10),followup_note:'Boka mixpass'}}},
    rates:{currency:'SEK',default:650,per:{'Studio Nord AB':850},up:1},
    /* en pågående kampanj (Mer → Rewards → Poäng) */
    rewardsCfg:{campaigns:[{id:'k_demo',label:'Dubbla poäng i höst',from:D(-7),to:D(21),multiplier:2}],up:1}};
    return S;
};
