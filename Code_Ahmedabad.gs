/**
 * ============================================================================
 * BRAHMASTRA - BACKEND (Code.gs)
 *
 * Multi-cluster, master-routed dashboard. A live master Google Sheet maps each
 * user to their cluster + Drive folder. Data files live in the cluster folder,
 * named {base}_{clusterKey}_DD_MM.csv (newest date wins), e.g.
 * current_month_bharat_mh_28_07.csv. See MULTI-CLUSTER MASTER ROUTING below.
 *
 * Roles: KAM (own res via AMTL) / ZH (their KAMs) / CEO (whole cluster) /
 * Super-core (all clusters KAM-level, or drill into any one via the top dropdown).
 * ============================================================================
 */

function doGet(e) {
  // Capture who is viewing while we still can (this runs in the user's
  // request context).
  var who = '';
  try { who = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (err) {}

  // Gate on the server: people without access never receive the dashboard
  // markup at all, only a small request page.
  var allowed = false;
  try {
    var isAdmin = isSuperUser_(who);
    // Mapped in master (ceo/tl/kam) OR super OR granted OR appears in data.
    allowed = isAdmin || isMappedInMaster_(who) || isGranted_(who) || hasPortfolio_(who);
  } catch (err) { allowed = false; }

  if (!allowed) {
    var a = HtmlService.createTemplateFromFile('NoAccess');
    a.VIEWER_EMAIL = who;
    return a.evaluate()
      .setTitle(e && e.parameter && String(e.parameter.app || '').toLowerCase() === 'beat' ? 'Beat Plan access' : 'Brahmastra')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
  }

  // A separate, Beat-only front end shares every existing data source,
  // permission check and server function with the main dashboard.
  var beatOnly = e && e.parameter && String(e.parameter.app || '').toLowerCase() === 'beat';
  var t = HtmlService.createTemplateFromFile(beatOnly ? 'BeatPlan' : 'Index');
  t.VIEWER_EMAIL = who;
  return t.evaluate()
    .setTitle(beatOnly ? 'Beat Plan' : 'Brahmastra')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
}

/* ========================================================================== */
/* WEEKLY MERCHANT PLAN — copy-only module                                    */
/* This module belongs only to Brahmastra_Weekly_Plan.gs.                      */
/* ========================================================================== */

var WEEKLY_PLAN_PROP_ = 'BRAHMASTRA_WEEKLY_PLAN_BOOK_ID';
var WEEKLY_PLAN_SHEET_ = 'Weekly Plans';
var WEEKLY_PLAN_HEADERS_ = ['Plan ID','Week Start','Meeting Date','KAM Email','Cluster','Res ID','Restaurant','City','Priority','Meeting Time','Objective','Talking Points','Deck Link','Next Action','Follow-up Date','Status','Updated At','Completed At','Plan Source','Priority Score','Auto Rationale','Meeting Outcome','Merchant Commitment','Commitment Owner','Commitment Due Date','Check-in At','Check-out At','Res Latitude','Res Longitude','Calendar Event ID','Arrived At','Arrival Latitude','Arrival Longitude','Arrival Distance Metres','Meeting Started At','Meeting Ended At','Recording URL','Recording File ID','Live Transcript','Manual Meeting Notes','Meeting Summary','Transcript Status','Meeting Type','Commitment Reminder Sent At','Brand Res IDs','Brand Outlet Locations','Selected Res IDs','Visit Location Type'];
var WEEKLY_PLAN_GLOBAL_AI_PROP_ = 'BRAHMASTRA_WEEKLY_PLAN_GLOBAL_AI';
WEEKLY_PLAN_HEADERS_.push('Completion Metric Snapshots','Snapshot Capture Status');
WEEKLY_PLAN_HEADERS_.push('Meeting Point Snapshot');
WEEKLY_PLAN_HEADERS_.push('Virtual Merchant Email','Google Meet URL','Meet Notes URL','Meet Notes Imported At');
WEEKLY_PLAN_HEADERS_.push('Virtual Meeting Organiser Email');
WEEKLY_PLAN_HEADERS_.push('Route Order');
WEEKLY_PLAN_HEADERS_.push('Planned Mode');
WEEKLY_PLAN_HEADERS_.push('KAM Commitment','MX Commitment');

// Shared control workbook requested for the Ahmedabad Beat pilot. JSON remains
// the fast operational source; this workbook is the human-readable mirror and
// the editable control plane for scheduling/scoring rules.
var BEAT_CONTROL_BOOK_ID_ = '1HnMFzIvnReDem3aLhMvIb8hquO0pqqJURKyCKYK2t5g';
var BEAT_PLAN_MIRROR_SHEET_ = 'Beat Plan Backend';
var BEAT_LOGIC_SHEET_ = 'Logic Config';
var BEAT_ALGORITHM_SHEET_ = 'Algorithm Rules';
var BEAT_LOGIC_LOG_SHEET_ = 'Logic Change Log';
var BEAT_LOGIC_CACHE_KEY_ = 'beat_logic_config_v1';

function beatLogicDefinitions_() {
  return [
    {key:'weight_ads',category:'Priority score',value:35,type:'number',min:0,max:100,unit:'%',label:'Ads weight',description:'Share of metric priority score assigned to ads performance.'},
    {key:'weight_promos',category:'Priority score',value:30,type:'number',min:0,max:100,unit:'%',label:'Promos weight',description:'Share assigned to MVD, Salt and discount/promo opportunity.'},
    {key:'weight_funnel',category:'Priority score',value:15,type:'number',min:0,max:100,unit:'%',label:'Funnel weight',description:'Share assigned to impression-to-order funnel gaps.'},
    {key:'weight_hygiene',category:'Priority score',value:10,type:'number',min:0,max:100,unit:'%',label:'Hygiene weight',description:'Share assigned to visibility, rating and menu hygiene.'},
    {key:'weight_segmentation',category:'Priority score',value:10,type:'number',min:0,max:100,unit:'%',label:'Segmentation weight',description:'Share assigned to new, repeat, lapsed, PG and mealtime mix.'},
    {key:'repeat_p0_days',category:'Repeat eligibility',value:14,type:'integer',min:1,max:120,unit:'days',label:'Highest urgency repeat',description:'Minimum repeat interval for backend P0 brands unless a due commitment or fresh deterioration overrides it.'},
    {key:'repeat_p1_days',category:'Repeat eligibility',value:21,type:'integer',min:1,max:180,unit:'days',label:'Medium urgency repeat',description:'Minimum repeat interval for backend P1 brands.'},
    {key:'repeat_p2_days',category:'Repeat eligibility',value:30,type:'integer',min:1,max:365,unit:'days',label:'Standard repeat',description:'Minimum repeat interval for backend P2 brands.'},
    {key:'daily_capacity_units',category:'Daily capacity',value:28,type:'integer',min:4,max:60,unit:'units',label:'Daily workload capacity',description:'Total workload units available on a working day.'},
    {key:'onsite_unit_cost',category:'Daily capacity',value:4,type:'integer',min:1,max:12,unit:'units',label:'On-site workload cost',description:'Capacity units consumed by one on-site brand visit.'},
    {key:'virtual_unit_cost',category:'Daily capacity',value:2,type:'integer',min:1,max:8,unit:'units',label:'Virtual workload cost',description:'Capacity units consumed by one virtual meeting.'},
    {key:'call_unit_cost',category:'Daily capacity',value:1,type:'integer',min:1,max:6,unit:'units',label:'Call workload cost',description:'Capacity units consumed by one call.'},
    {key:'max_onsite_per_day',category:'Daily capacity',value:5,type:'integer',min:1,max:10,unit:'visits',label:'Maximum on-site visits',description:'Hard maximum of on-site brand visits on one day.'},
    {key:'route_cluster_radius_km',category:'Route quality',value:4,type:'number',min:0.5,max:25,unit:'km',label:'On-site pocket radius',description:'Qualified brands within this radius may form the same daily route pocket.'},
    {key:'route_max_leg_km',category:'Route quality',value:6,type:'number',min:0.5,max:40,unit:'km',label:'Maximum route leg',description:'Maximum straight-line distance between consecutive on-site stops.'},
    {key:'evening_cutoff_hour',category:'Planning window',value:18,type:'integer',min:0,max:23,unit:'hour',label:'Evening build cutoff',description:'At or after this local hour, a new plan starts from the next calendar day.'},
    {key:'visibility_target',category:'Metric thresholds',value:95,type:'number',min:0,max:100,unit:'%',label:'Visibility target',description:'Target used for persistent hygiene-gap and repeat-deterioration checks.'},
    {key:'rating_target',category:'Metric thresholds',value:4,type:'number',min:0,max:5,unit:'rating',label:'Rating target',description:'Target used for customer-experience gap checks.'},
    {key:'menu_score_target',category:'Metric thresholds',value:80,type:'number',min:0,max:100,unit:'%',label:'Menu score target',description:'Target used for content-health gap checks.'},
    {key:'ads_roi_floor',category:'Metric thresholds',value:2.5,type:'number',min:0,max:50,unit:'x',label:'Healthy ads ROI floor',description:'ROI level above which productive Ads/CV can be considered after delivery and coverage checks.'}
  ];
}

function beatControlBook_() { return SpreadsheetApp.openById(BEAT_CONTROL_BOOK_ID_); }
function beatStyleControlHeader_(sheet,lastColumn) {
  sheet.setFrozenRows(1);
  sheet.getRange(1,1,1,lastColumn).setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#123D36');
}
function beatEnsureControlSheets_() {
  var book=beatControlBook_(),defs=beatLogicDefinitions_(),logic=book.getSheetByName(BEAT_LOGIC_SHEET_);
  if(!logic)logic=book.insertSheet(BEAT_LOGIC_SHEET_);
  var headers=['Key','Category','Value','Type','Min','Max','Unit','Setting','What it controls','Updated At','Updated By'];
  if(logic.getLastRow()<1){logic.getRange(1,1,1,headers.length).setValues([headers]);beatStyleControlHeader_(logic,headers.length);logic.setColumnWidths(1,1,190);logic.setColumnWidths(2,1,145);logic.setColumnWidths(3,1,90);logic.setColumnWidths(8,1,210);logic.setColumnWidths(9,1,430);}
  var rows=logic.getDataRange().getValues(),existing={};rows.slice(1).forEach(function(r){existing[String(r[0]||'')]=true;});
  var missing=defs.filter(function(d){return !existing[d.key];}).map(function(d){return [d.key,d.category,d.value,d.type,d.min,d.max,d.unit,d.label,d.description,'',''];});
  if(missing.length)logic.getRange(logic.getLastRow()+1,1,missing.length,headers.length).setValues(missing);
  var algorithm=book.getSheetByName(BEAT_ALGORITHM_SHEET_);if(!algorithm)algorithm=book.insertSheet(BEAT_ALGORITHM_SHEET_);
  if(algorithm.getLastRow()<1){
    var ah=['Step','Stage','Rule','Inputs','Output','Controlled by'];
    var ar=[
      [1,'Candidate eligibility','Only metric-qualified brands enter the pool. Distance never creates eligibility.','Ads, promos, funnel, hygiene, segmentation, flags','Qualified brand candidates','Metric thresholds and source data'],
      [2,'Priority score','Normalise each available gap to 0–100, then apply the editable weights.','Five metric-family gaps','Weighted commercial priority score','weight_*'],
      [3,'Brand grouping','Group eligible restaurant IDs by brand; keep all outlets available for the visit checkpoint.','Brand name, MID, Chain ID, Res ID','One beat card per brand','Source mapping'],
      [4,'Repeat check','Do not repeat an unfinished meeting. Allow a due commitment or fresh metric deterioration; otherwise apply the priority cooldown.','History, snapshots, due dates','Eligible date and reason','repeat_p0_days, repeat_p1_days, repeat_p2_days'],
      [5,'Rolling window','Build eight calendar dates from the effective start. Weekends and leave are visible but not auto-filled.','Build timestamp, leave dates','Working-day plan window','evening_cutoff_hour'],
      [6,'On-site pocket','Start from the KAM office and choose a compact pocket only from already-qualified brands.','Office GPS, merchant GPS, business score','Ordered on-site route','route_cluster_radius_km, route_max_leg_km'],
      [7,'Capacity fill','Protect on-site capacity, then use remaining units for calls/virtual. Overflow moves to later working days.','Existing load, route, call queue','Balanced daily plan','daily_capacity_units, *_unit_cost, max_onsite_per_day'],
      [8,'Reschedule reflow','Moving one meeting or a whole day rebalances the affected horizon and recalculates the route. Lower-ranked overflow may become a call.','Selected date, protected work, route geometry','Reflowed future schedule','Capacity and route settings'],
      [9,'Persistence','Write the KAM JSON first, then incrementally mirror the same rows to the control workbook.','Every plan mutation','Fast app state plus Sheet audit copy','System managed']
    ];
    algorithm.getRange(1,1,1,ah.length).setValues([ah]);algorithm.getRange(2,1,ar.length,ah.length).setValues(ar);beatStyleControlHeader_(algorithm,ah.length);algorithm.setColumnWidths(1,1,55);algorithm.setColumnWidths(2,1,150);algorithm.setColumnWidths(3,4,330);algorithm.getRange(2,1,ar.length,ah.length).setWrap(true).setVerticalAlignment('top');
  }
  var log=book.getSheetByName(BEAT_LOGIC_LOG_SHEET_);if(!log)log=book.insertSheet(BEAT_LOGIC_LOG_SHEET_);
  if(log.getLastRow()<1){log.appendRow(['Changed At','Changed By','Key','Old Value','New Value']);beatStyleControlHeader_(log,5);}
  return {book:book,logic:logic,algorithm:algorithm,log:log};
}

function beatLogicConfig_(force) {
  var defs=beatLogicDefinitions_(),values={};defs.forEach(function(d){values[d.key]=d.value;});
  try {
    var cache=CacheService.getScriptCache();if(!force){var hit=cache.get(BEAT_LOGIC_CACHE_KEY_);if(hit)try{return JSON.parse(hit);}catch(ignore){}}
    var control=beatEnsureControlSheets_(),rows=control.logic.getDataRange().getValues();rows.slice(1).forEach(function(r){var key=String(r[0]||''),def=defs.filter(function(d){return d.key===key;})[0];if(!def)return;var n=Number(r[2]);if(isFinite(n)&&n>=def.min&&n<=def.max)values[key]=def.type==='integer'?Math.round(n):n;});
    try{cache.put(BEAT_LOGIC_CACHE_KEY_,JSON.stringify(values),120);}catch(ignore2){}
  } catch(controlError) { try{Logger.log('Beat logic control Sheet unavailable; using validated defaults: '+controlError);}catch(ignore3){} }
  return values;
}
function beatLogicValue_(key){var values=beatLogicConfig_(false),defs=beatLogicDefinitions_(),def=defs.filter(function(d){return d.key===key;})[0];return values[key]===undefined?(def?def.value:null):values[key];}
function beatAssertLogicAdmin_(viewer){var email=weeklyPlanLower_(viewer);if(!email)try{email=weeklyPlanLower_(Session.getActiveUser().getEmail());}catch(ignore){}if(!isSuperUser_(email))throw new Error('Logic controls are available only to Super/Admin users.');return email;}
function getBeatLogicConfig(viewer) {
  var email=beatAssertLogicAdmin_(viewer),values=beatLogicConfig_(false);
  return {ok:true,canEdit:true,values:values,definitions:beatLogicDefinitions_(),sheetUrl:'https://docs.google.com/spreadsheets/d/'+BEAT_CONTROL_BOOK_ID_+'/edit',updatedFor:email};
}
function reloadBeatLogicConfig(viewer){beatAssertLogicAdmin_(viewer);CacheService.getScriptCache().remove(BEAT_LOGIC_CACHE_KEY_);return getBeatLogicConfig(viewer);}
function saveBeatLogicConfig(patch,viewer) {
  var email=beatAssertLogicAdmin_(viewer),defs=beatLogicDefinitions_(),byKey={};defs.forEach(function(d){byKey[d.key]=d;});patch=patch||{};
  var current=beatLogicConfig_(true),next={};Object.keys(current).forEach(function(k){next[k]=current[k];});
  Object.keys(patch).forEach(function(key){var d=byKey[key];if(!d)throw new Error('Unknown logic setting: '+key);var n=Number(patch[key]);if(!isFinite(n)||n<d.min||n>d.max)throw new Error(d.label+' must be between '+d.min+' and '+d.max+'.');next[key]=d.type==='integer'?Math.round(n):n;});
  var weightTotal=next.weight_ads+next.weight_promos+next.weight_funnel+next.weight_hygiene+next.weight_segmentation;if(Math.abs(weightTotal-100)>.001)throw new Error('Priority weights must total 100%. Current total: '+weightTotal+'%.');
  var control=beatEnsureControlSheets_(),rows=control.logic.getDataRange().getValues(),changes=[],now=new Date();
  for(var i=1;i<rows.length;i++){var key=String(rows[i][0]||'');if(!byKey[key]||patch[key]===undefined)continue;var old=rows[i][2],value=next[key];control.logic.getRange(i+1,3).setValue(value);control.logic.getRange(i+1,10,1,2).setValues([[now,email]]);if(String(old)!==String(value))changes.push([now,email,key,old,value]);}
  if(changes.length)control.log.getRange(control.log.getLastRow()+1,1,changes.length,5).setValues(changes);
  CacheService.getScriptCache().remove(BEAT_LOGIC_CACHE_KEY_);return getBeatLogicConfig(viewer);
}

// Pilot preferences are scoped to the authenticated/effective KAM and cluster.
function beatPilotPreferenceSheet_() {
 var book=weeklyPlanBook_(), sheet=book.getSheetByName('Beat Pilot Preferences');
 if(!sheet){sheet=book.insertSheet('Beat Pilot Preferences');sheet.appendRow(['KAM Email','Cluster','Kind','Key','JSON','Updated At']);sheet.setFrozenRows(1);}
 return sheet;
}
function beatPilotPreferences_(user) {
 var result={leaveDates:[],points:{}}, rows=beatPilotPreferenceSheet_().getDataRange().getValues();
 rows.slice(1).forEach(function(r){if(weeklyPlanLower_(r[0])!==weeklyPlanLower_(user.email)||weeklyPlanLower_(r[1])!==weeklyPlanLower_(user.cluster))return;
  var value;try{value=JSON.parse(String(r[4]));}catch(e){return;}
  if(r[2]==='leave')result.leaveDates=value;
  if(r[2]==='point')result.points[String(r[3])]=value;
 });return result;
}
function beatPilotPutPreference_(user,kind,key,value) {
 var sheet=beatPilotPreferenceSheet_(),rows=sheet.getDataRange().getValues(),record=[user.email,user.cluster||'',kind,key,JSON.stringify(value),new Date()];
 for(var i=1;i<rows.length;i++)if(weeklyPlanLower_(rows[i][0])===weeklyPlanLower_(user.email)&&weeklyPlanLower_(rows[i][1])===weeklyPlanLower_(user.cluster)&&rows[i][2]===kind&&rows[i][3]===key){sheet.getRange(i+1,1,1,6).setValues([record]);return;}
 sheet.appendRow(record);
}
function beatPilotDate_(value) {
 var s=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||isNaN(Date.parse(s+'T12:00:00Z'))||new Date(s+'T12:00:00Z').toISOString().slice(0,10)!==s)throw new Error('Use a valid date (YYYY-MM-DD).');return s;
}
function beatPilotDays_(start,leaves,count) {
 start=beatPilotDate_(start);var days=[],skip={};(leaves||[]).forEach(function(d){skip[d]=true;});
 for(var n=0;n<370&&days.length<(count||5);n++){var date=weeklyPlanRepeatDay_(start,n),dow=new Date(date+'T12:00:00Z').getUTCDay();if(dow!==0&&dow!==6&&!skip[date])days.push(date);}
 if(days.length<(count||5))throw new Error('Not enough working days in the next year.');return days;
}
function beatPilotWindow_(user,start) {
 var today=weeklyPlanDate_(new Date()),first=start?beatPilotDate_(start):today,dates=[];
 // Inclusive rolling week: a Friday build includes the following Friday.
 // Weekends and leave remain visible, but are not auto-assigned meetings.
 for(var i=0;i<=7;i++)dates.push(weeklyPlanRepeatDay_(first,i));
 return dates;
}
function getBeatPilotSettings(viewer,clusterOverride,viewAsKam) {
 var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),prefs=beatPilotPreferences_(user);
 return {leaveDates:prefs.leaveDates,dates:beatPilotWindow_(user),today:weeklyPlanDate_(new Date())};
}
function beatPilotOpen_(r){return ['planned','follow-up','no-show','reschedule requested'].indexOf(weeklyPlanLower_(r[15]))>=0;}
function beatPilotMovable_(r){return beatPilotOpen_(r)&&!r[30]&&!r[34]&&!r[35];}
function beatPilotMoveRows_(sheet,items,dates,email,rows,exact) {
 var ids={};items.forEach(function(x){ids[String(x.row[0])]=true;});var retained=rows.filter(function(r){return !ids[String(r[0])];});
 var loads={};dates.forEach(function(d){loads[d]=weeklyPlanDayLoad_(retained,email,d);});
 var capacity=weeklyPlanDailyCapacity_(),picks=items.map(function(item){var units=weeklyPlanRowUnits_(item.row),date=dates.filter(function(d){return loads[d]+units<=capacity;})[0];if(!date)throw new Error(exact?'Target day exceeds '+capacity+' workload units. Choose another day; no meetings were moved.':'Not enough working-day capacity; no meetings were moved.');loads[date]+=units;return {item:item,date:date};});
 // All validation and capacity calculations finish before the first write.
 picks.forEach(function(p){var r=p.item.row.slice();while(r.length<WEEKLY_PLAN_HEADERS_.length)r.push('');r[1]=weeklyPlanMonday_(p.date);r[2]=p.date;r[9]='';r[16]=new Date();sheet.getRange(p.item.rowNo,1,1,WEEKLY_PLAN_HEADERS_.length).setValues([r]);});
 return picks.map(function(p){return {id:String(p.item.row[0]),date:p.date};});
}
function beatPilotSyncMoves_(moves,viewer,clusterOverride,viewAsKam){var warnings=[];(moves||[]).forEach(function(m){try{var r=syncWeeklyPlanCalendar(m.id,viewer,clusterOverride,viewAsKam);if(!r.ok)warnings.push(r.message||'Calendar sync needs attention.');}catch(e){warnings.push(String(e.message||e));}});return warnings;}
function weeklyPlanReorderDayRoutes_(sheet,user,dates){
 var wanted={};(dates||[]).forEach(function(d){wanted[d]=true;});if(!Object.keys(wanted).length)return;
 var values=sheet.getDataRange().getValues(),groups={};values.slice(1).forEach(function(r,i){var d=weeklyPlanDate_(r[2]);if(!wanted[d]||weeklyPlanLower_(r[3])!==weeklyPlanLower_(user.email)||!weeklyPlanClusterMatch_(r[4],user.cluster)||/cancelled|canceled/i.test(String(r[15])))return;(groups[d]||(groups[d]=[])).push({row:r,rowNo:i+2,latitude:weeklyPlanLatitude_(r[27]),longitude:weeklyPlanLongitude_(r[28]),priority:r[8],score:r[19]});});
 Object.keys(groups).forEach(function(d){var physical=groups[d].filter(function(x){return weeklyPlanRowMode_(x.row)==='Physical';}),calls=groups[d].filter(function(x){return weeklyPlanRowMode_(x.row)!=='Physical';});var ordered=weeklyPlanRouteOrder_(physical,physical.length,{latitude:user.officeLatitude,longitude:user.officeLongitude}).concat(calls.sort(function(a,b){return weeklyPlanNumber_(b.score)-weeklyPlanNumber_(a.score);}));ordered.forEach(function(x,index){sheet.getRange(x.rowNo,57).setValue(index+1);});});
}
function saveBeatPilotLeaveDays(dates,viewer,clusterOverride,viewAsKam) {
 var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Select a KAM first.');
 if(!Array.isArray(dates)||dates.length>180)throw new Error('Select up to 180 leave dates.');
 var today=weeklyPlanDate_(new Date()),clean=dates.map(beatPilotDate_).filter(function(d,i,a){return d>=today&&a.indexOf(d)===i;}).sort(),lock=LockService.getScriptLock(),moves=[];
 try{lock.waitLock(20000);var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues(),items=[];
  rows.slice(1).forEach(function(r,i){if(weeklyPlanLower_(r[3])===weeklyPlanLower_(user.email)&&weeklyPlanClusterMatch_(r[4],user.cluster)&&clean.indexOf(weeklyPlanDate_(r[2]))>=0&&beatPilotOpen_(r)){if(!beatPilotMovable_(r))throw new Error('A meeting on a selected leave date has already started. Finish it or choose another date.');items.push({row:r,rowNo:i+2});}});
  // Leave reflow never pulls future meetings earlier than their current date.
  var future=beatPilotDays_(today,clean,60),virtual=rows.slice(1).map(function(r){return r.slice();}),staged=[];
  var capacity=weeklyPlanDailyCapacity_();items.sort(function(a,b){return weeklyPlanDate_(a.row[2]).localeCompare(weeklyPlanDate_(b.row[2]));}).forEach(function(item){var d=future.filter(function(d){return d>=weeklyPlanDate_(item.row[2])&&weeklyPlanDayLoad_(virtual,user.email,d)+weeklyPlanRowUnits_(item.row)<=capacity;})[0];if(!d)throw new Error('Not enough capacity to reflow leave days. Nothing was changed.');virtual.forEach(function(r){if(r[0]===item.row[0])r[2]=d;});staged.push({item:item,date:d});});
  staged.forEach(function(p){moves=moves.concat(beatPilotMoveRows_(sheet,[p.item],[p.date],user.email,virtual,true));});
  beatPilotPutPreference_(user,'leave','dates',clean);
 }finally{try{lock.releaseLock();}catch(e){}}
 return {ok:true,moved:moves.length,leaveDates:clean,dates:beatPilotWindow_(user),calendarWarnings:beatPilotSyncMoves_(moves,viewer,clusterOverride,viewAsKam)};
}
function bulkRescheduleBeatDay(sourceDate,targetDate,viewer,clusterOverride,viewAsKam) {
 sourceDate=beatPilotDate_(sourceDate);targetDate=beatPilotDate_(targetDate);var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);
 if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Select a KAM first.');
 if(!weeklyPlanRouteStart_({latitude:user.officeLatitude,longitude:user.officeLongitude}))throw new Error('Office latitude/longitude is missing for this KAM in Master of Ahmedabad. Add it before rebuilding the route.');
 if(targetDate<=sourceDate||targetDate<weeklyPlanDate_(new Date()))throw new Error('Choose a working date after the source day.');
 var lock=LockService.getScriptLock(),moves=[],skipped=0,displayDates=[];
 try{lock.waitLock(20000);if(beatPilotDays_(targetDate,beatPilotPreferences_(user).leaveDates,1)[0]!==targetDate)throw new Error('Target must be a working weekday, not leave.');
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues(),sourceItems=[],groups={},leaves=beatPilotPreferences_(user).leaveDates||[];
  rows.slice(1).forEach(function(r,i){
    if(weeklyPlanLower_(r[3])!==weeklyPlanLower_(user.email)||!weeklyPlanClusterMatch_(r[4],user.cluster))return;
    var d=weeklyPlanDate_(r[2]);
    if(d===sourceDate){if(beatPilotMovable_(r))sourceItems.push({row:r.slice(),rowNo:i+2});else skipped++;}
    if(d>=targetDate&&beatPilotMovable_(r))(groups[d]||(groups[d]=[])).push({row:r.slice(),rowNo:i+2});
  });
  if(!sourceItems.length)throw new Error('No unstarted pending meetings to move on that day.');
  // Shift complete daily blocks forward, farthest first: B→C causes C→D,
  // D→E and E→a newly exposed working day. This preserves daily intent.
  var days=beatPilotDays_(targetDate,leaves,90),empty=-1;
  for(var di=0;di<days.length;di++){if(!(groups[days[di]]||[]).length){empty=di;break;}}
  if(empty<0)throw new Error('No free working day is available in the next 90 days. Nothing was moved.');
  var staged=[];
  for(var gi=empty-1;gi>=0;gi--)(groups[days[gi]]||[]).forEach(function(item){staged.push({item:item,date:days[gi+1]});});
  sourceItems.forEach(function(item){staged.push({item:item,date:targetDate});});
  var stagedIds={};staged.forEach(function(x){stagedIds[String(x.item.row[0])]=true;});
  var virtual=rows.slice(1).filter(function(r){return !stagedIds[String(r[0])];}).map(function(r){return r.slice();});
  staged.forEach(function(x){x.item.row[2]=x.date;x.item.row[9]='';x.item.row[16]=new Date();virtual.push(x.item.row);});
  // A daily block keeps at most five onsite visits. Lowest-priority onsite
  // overflow becomes a call; calls may use all remaining 28 workload units.
  var affectedDates={};staged.forEach(function(x){affectedDates[x.date]=true;});
  Object.keys(affectedDates).forEach(function(d){
    var day=virtual.filter(function(r){return weeklyPlanLower_(r[3])===weeklyPlanLower_(user.email)&&weeklyPlanDate_(r[2])===d&&!/cancelled|canceled/i.test(String(r[15]));});
    var onsite=day.filter(function(r){return weeklyPlanRowMode_(r)==='Physical'&&beatPilotMovable_(r);});
    onsite.sort(function(a,b){return ({P2:0,P1:1,P0:2}[a[8]]||0)-({P2:0,P1:1,P0:2}[b[8]]||0)||weeklyPlanNumber_(a[19])-weeklyPlanNumber_(b[19]);});
    function units_(){return day.reduce(function(n,r){return n+weeklyPlanRowUnits_(r);},0);}
    var capacity=weeklyPlanDailyCapacity_(),maxOnsite=weeklyPlanMaxOnsite_();while((onsite.length>maxOnsite||units_()>capacity)&&onsite.length){var demote=onsite.shift();demote[42]='';demote[57]='Call';}
    var physicalCount=day.filter(function(r){return weeklyPlanRowMode_(r)==='Physical';}).length;
    if(units_()>capacity||physicalCount>maxOnsite)throw new Error('Protected work leaves insufficient capacity on a shifted day. Nothing was changed.');
  });
  var order={};staged.forEach(function(x){var r=x.item.row,d=x.date;r[1]=weeklyPlanMonday_(d);order[d]=(order[d]||0)+1;r[56]=order[d];sheet.getRange(x.item.rowNo,1,1,WEEKLY_PLAN_HEADERS_.length).setValues([r]);moves.push({id:String(r[0]),date:d,mode:weeklyPlanRowMode_(r)});});weeklyPlanReorderDayRoutes_(sheet,user,Object.keys(affectedDates));
  displayDates=beatPilotWindow_(user);var last=days[empty];if(displayDates.indexOf(last)<0)displayDates.push(last);displayDates.sort();
 }finally{try{lock.releaseLock();}catch(e){}}
 var monday=weeklyPlanMonday_(displayDates[0]||targetDate),fresh=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_).getDataRange().getValues().slice(1);
 var plans=fresh.filter(function(r){return weeklyPlanLower_(r[3])===weeklyPlanLower_(user.email)&&weeklyPlanClusterMatch_(r[4],user.cluster)&&displayDates.indexOf(weeklyPlanDate_(r[2]))>=0;}).map(weeklyPlanObject_).sort(function(a,b){return a.meetingDate.localeCompare(b.meetingDate)||(a.routeOrder||0)-(b.routeOrder||0);});
 var team=null;
 ahmedabadWritePlanSnapshot_(user,monday,displayDates,plans,team);
 return {ok:true,moved:moves.length,skipped:skipped,targetDate:targetDate,dates:displayDates,plans:plans,team:team,calendarWarnings:beatPilotSyncMoves_(moves,viewer,clusterOverride,viewAsKam)};
}
function saveBeatMeetingPoint(planId,point,viewer,clusterOverride,viewAsKam) {
 var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),p=point||{},lat=weeklyPlanLatitude_(p.latitude),lng=weeklyPlanLongitude_(p.longitude),label=String(p.label||'').trim();
 if(!label||label.length>300||lat===null||lng===null)throw new Error('Enter a meeting place/address and valid latitude / longitude.');
 var lock=LockService.getScriptLock();try{lock.waitLock(20000);var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues();
  for(var i=1;i<rows.length;i++){var r=rows[i];if(String(r[0])!==String(planId)||weeklyPlanLower_(r[3])!==weeklyPlanLower_(user.email)||!weeklyPlanClusterMatch_(r[4],user.cluster))continue;
   if(!beatPilotMovable_(r))throw new Error('A started or completed meeting keeps its original location.');
   var value={label:label,latitude:lat,longitude:lng,updatedAt:weeklyPlanDateTime_(new Date())};
   sheet.getRange(i+1,51).setValue(JSON.stringify(value));sheet.getRange(i+1,28,1,2).setValues([[lat,lng]]);
   if(p.remember!==false)beatPilotPutPreference_(user,'point',weeklyPlanBrandKey_(r[6]),value);
   return {ok:true,point:value,remembered:p.remember!==false};
  }throw new Error('Meeting not available for your account.');
 }finally{try{lock.releaseLock();}catch(e){}}
}
function getBeatMeetingPoint(planId,viewer,clusterOverride,viewAsKam){
 var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),rows=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_).getDataRange().getValues();
 for(var i=1;i<rows.length;i++)if(String(rows[i][0])===String(planId)&&weeklyPlanLower_(rows[i][3])===weeklyPlanLower_(user.email)&&weeklyPlanClusterMatch_(rows[i][4],user.cluster)){var plan=weeklyPlanObject_(rows[i]);return {point:plan.meetingPoint||beatPilotPreferences_(user).points[weeklyPlanBrandKey_(plan.restaurant)]||null};}
 throw new Error('Meeting not available for your account.');
}
function getBeatPilotReminders(viewer,clusterOverride,viewAsKam){
 var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),today=weeklyPlanDate_(new Date()),end=beatPilotWindow_(user).slice(-1)[0],sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),people=weeklyPlanPeople_(),role=weeklyPlanRoleType_(user);
 return sheet.getDataRange().getValues().slice(1).map(weeklyPlanObject_).filter(function(p){var meta=people[weeklyPlanLower_(p.kamEmail)]||{};return weeklyPlanClusterMatch_(p.cluster,user.cluster)&&(role==='kam'?weeklyPlanLower_(p.kamEmail)===weeklyPlanLower_(user.email):role==='zh'?weeklyPlanLower_(meta.zhEmail)===weeklyPlanLower_(user.email):true);}).filter(function(p){return p.meetingDate!==today&&p.status!=='Closed'&&((p.merchantCommitment&&p.commitmentDueDate&&p.commitmentDueDate<=end)||(p.followUpDate&&p.followUpDate<=end));}).sort(function(a,b){return String(a.commitmentDueDate||a.followUpDate).localeCompare(String(b.commitmentDueDate||b.followUpDate));}).slice(0,30);
}
var WEEKLY_PLAN_OPENAI_KEY_PROP_ = 'OPENAI_API_KEY';
var WEEKLY_PLAN_DECK_FOLDER_PROP_ = 'BRAHMASTRA_WEEKLY_PLAN_DECK_FOLDER_ID';
var WEEKLY_PLAN_RECORDING_FOLDER_PROP_ = 'BRAHMASTRA_WEEKLY_PLAN_RECORDING_FOLDER_ID';

function weeklyPlanBootstrap(viewer, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  // One-time cleanup of the old derived schedule snapshot. The authoritative
  // file now uses beat_plan_ahmedabad_store_<kam>.json and is updated in place.
  try{ahmedabadInvalidateJsonCache_('schedule',user.email);}catch(ignoreLegacySchedule){}
  var weekStart = weeklyPlanDate_(new Date());
  // On the next dashboard visit, reflow any previous-day work that has not
  // been closed. This keeps the beat plan useful without asking a KAM to
  // manually rebuild the entire week after a busy day.
  var moved=weeklyPlanAutoCarryPastDue_(user, weekStart, clusterOverride, viewAsKam);
  var cached=!moved&&weeklyPlanRoleType_(user)==='kam'?ahmedabadReadPlanSnapshot_(user,weekStart):null;
  beatActivityLog_('app_open',user,{source:cached?'JSON cache':'Live plan'});
  if(cached)return {user:user,weekStart:weekStart,dates:cached.dates||beatPilotWindow_(user,weekStart),plans:cached.plans||[],team:cached.team||null,jsonCache:true};
  var dates=beatPilotWindow_(user,weekStart),plans=weeklyPlanScopedRows_(user,weekStart),team=weeklyPlanTeamReview_(user,weekStart);
  // A missing Drive snapshot means "read live". Do not silently recreate a
  // JSON file merely because the user refreshed; snapshots are written only
  // after a real plan mutation/build. This makes manual cache deletion useful.
  return { user:user, weekStart:weekStart, dates:dates, plans:plans, team:team, jsonCache:false };
}

function getWeeklyPlans(viewer, weekStart, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  var want=weeklyPlanDate_(weekStart || new Date());
  // Viewing an old week must stay read-only; only the live/current beat plan
  // is reflowed automatically.
  if (want === weeklyPlanDate_(new Date())) weeklyPlanAutoCarryPastDue_(user, want, clusterOverride, viewAsKam);
  var dates=beatPilotWindow_(user,want),plans=weeklyPlanScopedRows_(user,want),team=weeklyPlanTeamReview_(user,want);
  return { user:user, weekStart:want, dates:dates, plans:plans, team:team, jsonCache:false };
}

function saveBeatRouteOrder(planIds,planDate,viewer,clusterOverride,viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),date=beatPilotDate_(planDate);
  if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Choose a KAM view to arrange the route.');
  if(date<weeklyPlanDate_(new Date()))throw new Error('Past routes cannot be reordered.');
  if(!Array.isArray(planIds)||!planIds.length||planIds.length>40)throw new Error('Select the day’s route cards to reorder.');
  var ids=planIds.map(function(x){return String(x||'');}),seen={};
  ids.forEach(function(id){if(!id||seen[id])throw new Error('Route cards must be unique.');seen[id]=true;});
  var lock=LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues(),matches=[];
    for(var i=1;i<rows.length;i++)if(weeklyPlanLower_(rows[i][3])===weeklyPlanLower_(user.email)&&weeklyPlanDate_(rows[i][2])===date&&weeklyPlanClusterMatch_(rows[i][4],user.cluster))matches.push({rowNo:i+1,id:String(rows[i][0])});
    if(matches.length!==ids.length||matches.some(function(x){return !seen[x.id];}))throw new Error('The day changed while you were rearranging. Refresh and try again.');
    var order={};ids.forEach(function(id,index){order[id]=index+1;});
    matches.forEach(function(x){sheet.getRange(x.rowNo,57).setValue(order[x.id]);});
    var orderedPlans=weeklyPlanScopedRows_(user,date);ahmedabadWritePlanSnapshot_(user,date,beatPilotWindow_(user,date),orderedPlans,weeklyPlanTeamReview_(user,date));
    return {ok:true,date:date,plans:orderedPlans};
  } finally {try{lock.releaseLock();}catch(ignore){}}
}

// The saved weekly plan deliberately stores only the schedule.  This endpoint
// re-reads the latest restaurant row when a brief is opened, so an older plan
// still gets the full current metric diagnosis instead of only its old NOV
// talking points.
function weeklyPlanHistoryForBeat_(resId, email, cluster) {
  var key='beat_hist_'+weeklyPlanKey_(cluster)+'_'+weeklyPlanKey_(email)+'_'+String(resId),cache=CacheService.getScriptCache(),raw='';
  try { raw=cache.get(key);if(raw)return JSON.parse(raw); } catch(ignore) {}
  var history=getLastMetrics('month',resId,email,cluster,email);
  try { var json=JSON.stringify(history);if(json.length<90000)cache.put(key,json,600); } catch(cacheIgnore) {}
  return history;
}

// Build the same full restaurant scorecard that the Portfolio popup uses.
// Values are deliberately grouped into compact cards so the Beat popup stays
// readable on mobile while still exposing CM, LM, L2M and Cuisine × City
// benchmarks. Every /SV ratio below uses pure SV; packaging charges are never
// included in the denominator.
function weeklyPlanPortfolioParityCards_(history) {
  history=history||{};
  var cm=history.current||{},lm=history.metrics||{},l2m=history.metrics2||{},bench=history.peer&&history.peer.benchmarks||{},out=[];
  function num_(v){v=Number(v);return isFinite(v)?v:0;}
  function pct_(v){return num_(v).toFixed(1)+'%';}
  function money_(v){return weeklyPlanFmtNum_(num_(v));}
  function ratio_(row,n,d){return num_(row&&row[d])>0?num_(row&&row[n])/num_(row&&row[d])*100:0;}
  function vis_(row){return num_(row&&row.expected)>0?num_(row.actual)/num_(row.expected)*100:0;}
  function i2m_(row){return ratio_(row,'menuOpens','impressions');}
  function i2o_(row){return ratio_(row,'orderMakes','impressions');}
  function share_(row,key){return num_(row&&row.total_orders)>0?num_(row&&row[key])/num_(row.total_orders)*100:0;}
  function rawPct_(v){v=num_(v);return v>0&&v<=1?v*100:v;}
  function addPeriod_(arr,label,getter,formatter,allowZero){[['CM',cm],['LM',lm],['L2M',l2m]].forEach(function(x){var v=getter(x[1]||{});if((allowZero||v>0)&&isFinite(v))arr.push(x[0]+' '+label+' '+formatter(v));});}
  function addBench_(arr,key,label,formatter){var b=bench[key];if(!b)return;if(num_(b.avg)>0)arr.push('B.Avg '+label+' '+formatter(num_(b.avg)));if(num_(b.max)>0)arr.push('B.Max '+label+' '+formatter(num_(b.max)));}
  function card_(category,metric,condition,values,tone,rank){values=(values||[]).filter(Boolean);if(values.length)out.push({category:category,metric:metric,condition:condition,values:values,tone:tone||'watch',rank:rank||0});}
  var values=[];
  addPeriod_(values,'Orders',function(r){return num_(r.total_orders);},money_);addPeriod_(values,'SV',function(r){return num_(r.sv);},money_);addPeriod_(values,'CV',function(r){return num_(r.cv);},money_);addPeriod_(values,'ASV',function(r){return num_(r.total_orders)>0?num_(r.sv)/num_(r.total_orders):0;},money_);addPeriod_(values,'ACV',function(r){return num_(r.total_orders)>0?num_(r.cv)/num_(r.total_orders):0;},money_);addBench_(values,'asv','ASV',money_);addBench_(values,'acv','ACV',money_);
  card_('Top-line','Orders · SV · CV · ASV · ACV','Review current scale and unit economics against recent months and Cuisine × City.',values,'watch',1);
  values=[];
  addPeriod_(values,'Wallet share',function(r){return num_(r.sv)>0?(num_(r.commissionRevenue)+num_(r.ad_rev)+num_(r.mvdAmt)+num_(r.saltAmt))/num_(r.sv)*100:0;},pct_);addPeriod_(values,'Commission/SV',function(r){return ratio_(r,'commissionRevenue','sv');},pct_);addPeriod_(values,'Ads/SV',function(r){return ratio_(r,'ad_rev','sv');},pct_);addPeriod_(values,'MVD/SV',function(r){return ratio_(r,'mvdAmt','sv')||rawPct_(r.actual_mvd_sv);},pct_);addPeriod_(values,'Salt/SV',function(r){return ratio_(r,'saltAmt','sv');},pct_);addBench_(values,'walletShare','Wallet share',pct_);addBench_(values,'commissionSv','Commission/SV',pct_);addBench_(values,'adsSv','Ads/SV',pct_);addBench_(values,'mvdSv','MVD/SV',pct_);addBench_(values,'saltSv','Salt/SV',pct_);
  card_('Sharing','Wallet share & monetisation','Internal portfolio view of monetisation and investment mix; use pure SV as denominator.',values,'watch',2);
  values=[];
  addPeriod_(values,'Ads revenue',function(r){return num_(r.ad_rev);},money_);addPeriod_(values,'Ads/CV',function(r){return ratio_(r,'ad_rev','cv');},pct_);addPeriod_(values,'Ads ROI',function(r){return num_(r.adsRoi);},function(v){return v.toFixed(2);});addPeriod_(values,'Ad orders',function(r){return num_(r.adOrders);},money_);addPeriod_(values,'Ad order %',function(r){return share_(r,'adOrders');},pct_);addPeriod_(values,'Monthly booked ads',function(r){return num_(r.monthlyBookedAds);},money_);addPeriod_(values,'Delivery',function(r){return num_(r.deliveryPct);},pct_);addPeriod_(values,'Billed ads',function(r){return num_(r.billedAds);},money_);addPeriod_(values,'BAU billed',function(r){return num_(r.bauBilling);},money_);addPeriod_(values,'GM billed',function(r){return num_(r.gmBilling);},money_);addPeriod_(values,'BAU Ads/CV',function(r){return num_(r.bauAdsCv)||ratio_(r,'bauBilling','cv');},pct_);addPeriod_(values,'GM Ads/CV',function(r){return num_(r.gmAdsCv)||ratio_(r,'gmBilling','cv');},pct_);addPeriod_(values,'Effective BR',function(r){return num_(r.effBr);},pct_);addPeriod_(values,'Ineffective BR',function(r){return num_(r.ineffBr);},pct_);addPeriod_(values,'Ads res coverage',function(r){return num_(r.adsResCoverage);},pct_);addPeriod_(values,'Ads CV coverage',function(r){return num_(r.adsCvCoverage);},pct_);addPeriod_(values,'CPC',function(r){return num_(r.cpc);},function(v){return v.toFixed(2);});addPeriod_(values,'Ad impressions',function(r){return num_(r.adImpressions);},money_);addPeriod_(values,'Ad clicks',function(r){return num_(r.adClicks);},money_);addBench_(values,'adsCv','Ads/CV',pct_);addBench_(values,'adsRoi','Ads ROI',function(v){return v.toFixed(2);});addBench_(values,'deliveryPct','Delivery',pct_);addBench_(values,'cpc','CPC',function(v){return v.toFixed(2);});if(String(cm.growMaxxModel||'').trim())values.push('Grow Max model '+cm.growMaxxModel);if(num_(cm.growMaxxX)>0)values.push('Grow Max X '+pct_(cm.growMaxxX));if(num_(cm.growMaxxY)>0)values.push('Grow Max Y '+pct_(cm.growMaxxY));if(cm.autoRenewal!==''&&cm.autoRenewal!=null)values.push('Auto renewal '+(num_(cm.autoRenewal)>0?'On':'Off'));
  card_('Ads','Complete ads scorecard','Review absolute investment, delivery, return, dependency and Grow Max together.',values,'watch',3);
  values=[];
  addPeriod_(values,'Visibility',vis_,pct_);addPeriod_(values,'Rating',function(r){return num_(r.rating);},function(v){return v.toFixed(2);});addPeriod_(values,'Menu score',function(r){return num_(r.menuScore);},pct_);addPeriod_(values,'Image score',function(r){return num_(r.imageScore);},pct_);addPeriod_(values,'Description score',function(r){return num_(r.descScore);},pct_);addPeriod_(values,'Missing images',function(r){return num_(r.noImage);},money_);addPeriod_(values,'Missing descriptions',function(r){return num_(r.noDesc);},money_);addPeriod_(values,'Rejections',function(r){return num_(r.mxRejections);},money_);addPeriod_(values,'KPT delayed',function(r){return num_(r.kptDelayed);},money_);addPeriod_(values,'MX refunds',function(r){return num_(r.mxRefund);},money_);addPeriod_(values,'CX refunds',function(r){return num_(r.cxRefund);},money_);if(cm.thumbnailKnown)values.push('Thumbnail '+(num_(cm.hasThumbnail)>0?'Yes':'No'));addBench_(values,'visibility','Visibility',pct_);addBench_(values,'rating','Rating',function(v){return v.toFixed(2);});addBench_(values,'menuScore','Menu score',pct_);addBench_(values,'imageScore','Image score',pct_);addBench_(values,'descScore','Description score',pct_);
  card_('Hygiene','Complete hygiene scorecard','Review discoverability, content completeness, customer experience and operating quality.',values,(vis_(cm)>0&&vis_(cm)<95)||(num_(cm.rating)>0&&num_(cm.rating)<4)?'critical':'watch',4);
  values=[];
  addPeriod_(values,'Impressions',function(r){return num_(r.impressions);},money_);addPeriod_(values,'Menu opens',function(r){return num_(r.menuOpens);},money_);addPeriod_(values,'Cart builds',function(r){return num_(r.cartBuilds);},money_);addPeriod_(values,'Order makes',function(r){return num_(r.orderMakes);},money_);addPeriod_(values,'I2M',i2m_,pct_);addPeriod_(values,'M2C',function(r){return rawPct_(r.m2c);},pct_);addPeriod_(values,'C2O',function(r){return rawPct_(r.c2o);},pct_);addPeriod_(values,'M2O',function(r){return rawPct_(r.m2o);},pct_);addPeriod_(values,'I2O',i2o_,pct_);addBench_(values,'i2m','I2M',pct_);addBench_(values,'m2c','M2C',pct_);addBench_(values,'c2o','C2O',pct_);addBench_(values,'m2o','M2O',pct_);
  card_('Funnel','Impressions · I2M · M2C · C2O','Find the weakest conversion step using CM, LM, L2M and cohort benchmarks.',values,'watch',5);
  values=[];
  addPeriod_(values,'Actual M-share',function(r){return rawPct_(r.actual_mshare);},pct_);addPeriod_(values,'Intended M-share',function(r){return rawPct_(r.intended_mshare);},pct_);addPeriod_(values,'M-share',function(r){return rawPct_(r.mShare);},pct_);addPeriod_(values,'Z-share',function(r){return rawPct_(r.zShare);},pct_);addBench_(values,'mShare','M-share',pct_);addBench_(values,'zShare','Z-share',pct_);
  card_('Sharing','Actual & intended sharing','Compare merchant and platform sharing across periods and against the cohort.',values,'watch',6);
  values=[];
  [['New','newOrders'],['Repeat','repeatOrders'],['Lapsed','lapsedOrders'],['PG 7–10','pg710'],['PG 4–6','pg46'],['PG 1–3','pg13'],['Breakfast','breakfastOrders'],['Lunch','lunchOrders'],['Evening','eveningOrders'],['Dinner','dinnerOrders'],['Late night','lateNightOrders']].forEach(function(item){addPeriod_(values,item[0],function(r){return share_(r,item[1]);},pct_);addBench_(values,item[1],item[0],pct_);});
  card_('Customer segmentation','NRL · PG · mealtime','Use customer and daypart mix to tailor acquisition, repeat, reactivation, menu and offer actions.',values,'watch',7);
  values=[];
  [['P.E.',cm.peRaw],['Ads',cm.adsFlag],['AR',cm.arFlag],['GM1',cm.gm1],['GM2',cm.gm2],['GM3',cm.gm3],['SGM',cm.sgm],['MVD',cm.mvdSRaw],['Salt',cm.saltRaw],['Food mix',cm.vegType],['Cart-breaker',cm.cartBreaker]].forEach(function(x){if(String(x[1]||'').trim()!=='')values.push(x[0]+' '+String(x[1]));});if(String(cm.growMaxxModel||'').trim())values.push('Grow Max '+cm.growMaxxModel);if(num_(cm.growMaxxX)>0)values.push('Grow Max X '+pct_(cm.growMaxxX));if(num_(cm.growMaxxY)>0)values.push('Grow Max Y '+pct_(cm.growMaxxY));
  card_('Flags','Program flags & Grow Max','Use portfolio flags to confirm the exact program, offer and assortment discussion.',values,'watch',8);
  return out;
}
function getWeeklyPlanMetricBrief(planId, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), rows=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_).getDataRange().getValues(), plan=null;
  for (var i=1;i<rows.length;i++) if (String(rows[i][0])===String(planId)) { plan=weeklyPlanObject_(rows[i]); break; }
  if (!plan || !weeklyPlanScopedRows_(user, plan.weekStart).some(function(x){ return String(x.id)===String(plan.id); })) throw new Error('This meeting plan is not available for the current view.');
  var source=weeklyPlanSourceRows_(plan.kamEmail, clusterOverride || plan.cluster);
  var candidate=(weeklyPlanCandidates_(source.rows || [], plan.kamEmail, clusterOverride || plan.cluster, plan.cluster || user.cluster, source.novRows || []) || []).filter(function(x){ return String(x.resId)===String(plan.resId); })[0];
  var cards=candidate && candidate.briefCards ? JSON.parse(JSON.stringify(candidate.briefCards)) : [], evidence=candidate && candidate.aiMetrics ? (candidate.aiMetrics.canonical || {}) : {};
  // Reuse the exact Cuisine × City benchmark engine used by the Portfolio
  // popup. This keeps B.Avg / B.Max identical in both surfaces.
  try {
    var history=weeklyPlanHistoryForBeat_(plan.resId,plan.kamEmail,clusterOverride || plan.cluster),bench=history && history.peer && history.peer.benchmarks || {};
    evidence.cuisine_city_benchmarks=bench;evidence.cm=history.current || {};evidence.lm=history.metrics || {};evidence.l2m=history.metrics2 || {};
    function addBench_(card,key,label,percent){var b=bench[key];if(!card||!b)return;card.values=card.values||[];function add_(prefix,value){if(value==null||!isFinite(Number(value))||Number(value)<=0)return;var text=prefix+' '+label+' '+(percent?weeklyPlanFmtPct_(Number(value)):Number(value).toFixed(2));if(card.values.indexOf(text)<0)card.values.push(text);}add_('B.Avg',b.avg);add_('B.Max',b.max);}
    var detailed=weeklyPlanPortfolioParityCards_(history),duplicate={ads:1,'customer experience':1,hygiene:1,funnel:1,'customer segmentation':1,'operating flags':1,flags:1,sharing:1,'top-line':1};
    cards=detailed.concat(cards.filter(function(card){return !duplicate[String(card.category||'').toLowerCase()];}));
    cards.forEach(function(card){var name=String(card.metric||'').toLowerCase();if(name.indexOf('mvd &')>=0)addBench_(card,'mvdSv','MVD/SV',true);if(name.indexOf('merchant share')>=0)addBench_(card,'mShare','Merchant share',true);if(name.indexOf('salt/sv')>=0)addBench_(card,'saltSv','Salt/SV',true);});
  } catch(benchmarkIgnore) {}
  return {ok:true, planId:String(planId), cards:cards, evidence:evidence, generatedAt:new Date().getTime()};
}

function saveWeeklyPlan(payload, viewer, clusterOverride, viewAsKam) {
  payload = payload || {};
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  var book = weeklyPlanBook_();
  if(beatPilotPreferences_(user).leaveDates.indexOf(weeklyPlanDate_(payload.meetingDate||new Date()))>=0)throw new Error('This is a leave day. Choose another meeting date.');
  var sheet = book.getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows = sheet.getDataRange().getValues();
  var planId = String(payload.id || '').trim();
  var now = new Date();
  var prior = null;
  for (var p=1; p<rows.length; p++) if (String(rows[p][0]) === planId && String(rows[p][3]).toLowerCase() === user.email) { prior = rows[p]; break; }
  var dueDate = weeklyPlanDate_(payload.commitmentDueDate || (prior && prior[24]) || '');
  var priorDueDate = weeklyPlanDate_(prior && prior[24]);
  var record = [
    planId || ('WP-' + now.getTime() + '-' + Math.floor(Math.random()*10000)),
    weeklyPlanDate_(payload.weekStart || weeklyPlanMonday_(new Date())),
    weeklyPlanDate_(payload.meetingDate || new Date()),
    user.email,
    String(payload.cluster || user.cluster || ''),
    String(payload.resId || ''),
    String(payload.restaurant || '').trim(),
    String(payload.city || '').trim(),
    ['P0','P1','P2'].indexOf(String(payload.priority)) >= 0 ? String(payload.priority) : (prior && ['P0','P1','P2'].indexOf(String(prior[8])) >= 0 ? String(prior[8]) : 'P1'),
    String(payload.meetingTime || ''),
    String(payload.objective || '').trim(),
    String(payload.talkingPoints || '').trim(),
    String(payload.deckLink || '').trim(),
    String(payload.nextAction || '').trim(),
    String(payload.followUpDate || ''),
    ['Planned','Met','Follow-up','Closed'].indexOf(String(payload.status)) >= 0 ? String(payload.status) : 'Planned',
    now,
    String(payload.status) === 'Closed' ? now : '',
    String(payload.source || (prior && prior[18]) || 'Manual').trim() || 'Manual',
    weeklyPlanNumber_(payload.priorityScore || (prior && prior[19])),
    String(payload.autoRationale || (prior && prior[20]) || '').trim(),
    String(payload.meetingOutcome || (prior && prior[21]) || '').trim(),
    String(payload.merchantCommitment || (prior && prior[22]) || '').trim(),
    String(payload.commitmentOwner || (prior && prior[23]) || '').trim(),
    dueDate,
    String(payload.checkedInAt || (prior && prior[25]) || '').trim(),
    String(payload.checkedOutAt || (prior && prior[26]) || '').trim(),
    weeklyPlanLatitude_(payload.latitude != null ? payload.latitude : (prior && prior[27])),
    weeklyPlanLongitude_(payload.longitude != null ? payload.longitude : (prior && prior[28])),
    String(payload.calendarEventId || (prior && prior[29]) || '').trim(),
    String(payload.arrivedAt || (prior && prior[30]) || '').trim(),
    weeklyPlanLatitude_(payload.arrivalLatitude != null ? payload.arrivalLatitude : (prior && prior[31])),
    weeklyPlanLongitude_(payload.arrivalLongitude != null ? payload.arrivalLongitude : (prior && prior[32])),
    weeklyPlanNumber_(payload.arrivalDistanceMetres != null ? payload.arrivalDistanceMetres : (prior && prior[33])),
    String(payload.meetingStartedAt || (prior && prior[34]) || '').trim(),
    String(payload.meetingEndedAt || (prior && prior[35]) || '').trim(),
    String(payload.recordingUrl || (prior && prior[36]) || '').trim(),
    String(payload.recordingFileId || (prior && prior[37]) || '').trim(),
    String(payload.liveTranscript || (prior && prior[38]) || '').trim(),
    String(payload.manualMeetingNotes || (prior && prior[39]) || '').trim(),
    String(payload.meetingSummary || (prior && prior[40]) || '').trim(),
    String(payload.transcriptStatus || (prior && prior[41]) || '').trim(),
    weeklyPlanMeetingType_(payload.meetingType || (prior && prior[42])),
    dueDate && dueDate === priorDueDate ? String((prior && prior[43]) || '') : '',
    JSON.stringify(weeklyPlanIdList_(payload.brandResIds || (prior && weeklyPlanObject_(prior).brandResIds) || payload.resId || '')),
    Array.isArray(payload.brandOutletLocations) ? JSON.stringify(payload.brandOutletLocations) : String(payload.brandOutletLocations || (prior && prior[45]) || '').trim(),
    JSON.stringify(weeklyPlanIdList_(payload.selectedResIds || (prior && weeklyPlanObject_(prior).selectedResIds) || '')),
    String(payload.visitLocationType || (prior && prior[47]) || 'Merchant outlets').trim()
  ];
  var found = -1;
  for (var r=1; r<rows.length; r++) if (String(rows[r][0]) === record[0] && String(rows[r][3]).toLowerCase() === user.email) { found = r+1; break; }
  if (found > 0) {
    prior = rows[found-1];
    record[17] = String(payload.status) === 'Closed' ? (prior[17] || now) : '';
    sheet.getRange(found,1,1,record.length).setValues([record]);
  } else sheet.appendRow(record);
  if (dueDate) ensureWeeklyPlanReminderTrigger_();
  var savedPlans=weeklyPlanRows_(user.email,record[1]),savedTeam=weeklyPlanTeamReview_(user,record[1]);ahmedabadWritePlanSnapshot_(user,record[1],beatPilotWindow_(user,record[1]),savedPlans,savedTeam);
  return {ok:true, plan:weeklyPlanObject_(record), plans:savedPlans, team:savedTeam};
}

/** Lazily loads the signed-in KAM's own restaurant directory for the
 * contextual Add stop card. AMTL supplies identity/location; the latest
 * metric candidate supplies the objective and talking-point defaults. */
function getWeeklyPlanRestaurantOptions(viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);
  if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Choose a KAM view before adding a stop.');
  var amtl=loadAmtl_(user.email,clusterOverride),candidateById={};
  try {
    var source=weeklyPlanSourceRows_(user.email,clusterOverride),candidates=weeklyPlanCandidates_(source.rows||[],user.email,clusterOverride,user.cluster,source.novRows||[]);
    (candidates||[]).forEach(function(c){candidateById[String(c.resId)]=c;});
  } catch(candidateIgnore) {}
  var openByRes={};
  ahmedabadReadPlanStore_(user.email).map(weeklyPlanObject_).filter(function(p){return ['closed','met','cancelled','canceled'].indexOf(weeklyPlanLower_(p.status))<0;}).forEach(function(p){var id=String(p.resId||'');if(id&&(!openByRes[id]||String(p.meetingDate)>String(openByRes[id].meetingDate)))openByRes[id]=p;});
  var groups={};Object.keys(amtl).forEach(function(id){var m=amtl[id]||{};if(weeklyPlanLower_(m.am_email)!==weeklyPlanLower_(user.email)||!weeklyPlanClusterMatch_(m.cluster,user.cluster))return;var name=String(m.res_name||('Restaurant '+id)).trim(),key=weeklyPlanBrandKey_(name);if(!groups[key])groups[key]=[];groups[key].push(id);});
  var options=[];Object.keys(amtl).forEach(function(id){var m=amtl[id]||{};if(weeklyPlanLower_(m.am_email)!==weeklyPlanLower_(user.email)||!weeklyPlanClusterMatch_(m.cluster,user.cluster))return;var c=candidateById[id]||{},name=String(m.res_name||c.restaurant||('Restaurant '+id)).trim(),brandIds=(groups[weeklyPlanBrandKey_(name)]||[id]).slice();options.push({
    resId:String(id),restaurant:name,mid:String(m.mid||c.mid||''),chainId:String(m.chain_id||c.chainId||''),city:String(m.city||c.city||''),cluster:String(m.cluster||c.cluster||user.cluster||''),latitude:m.latitude,longitude:m.longitude,
    objective:String(c.objective||'1. Review the strongest Ads lever using available data.\n2. Review the strongest Promo lever using available data.\n3. Agree one measurable merchant commitment with owner and due date.'),talkingPoints:String(c.talkingPoints||''),nextAction:String(c.nextAction||'Record KAM and merchant commitments with due dates.'),priority:String(c.priority||'P2'),priorityScore:weeklyPlanNumber_(c.score),brandResIds:brandIds,
    existing:openByRes[id]?{id:openByRes[id].id,date:openByRes[id].meetingDate,mode:openByRes[id].meetingType||openByRes[id].plannedMode||'Physical',status:openByRes[id].status}:null
  });});
  options.sort(function(a,b){return a.restaurant.localeCompare(b.restaurant)||a.resId.localeCompare(b.resId);});
  return {ok:true,restaurants:options};
}

/** Adds a restaurant directly into the clicked day/mode. If the same Res ID
 * already has an open future meeting, the caller must explicitly choose to
 * move that plan; duplicate open meetings are never created. */
function saveWeeklyPlanQuickStop(payload, viewer, clusterOverride, viewAsKam) {
  payload=payload||{};var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);
  if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Choose a KAM view before adding a stop.');
  var date=weeklyPlanDate_(payload.meetingDate),resId=normId_(payload.resId),mode=weeklyPlanMeetingType_(payload.mode);
  if(!date||!resId)throw new Error('Choose a restaurant for this day.');if(mode!=='Physical'&&mode!=='Call')throw new Error('Choose On-site or Call.');
  var amtl=loadAmtl_(user.email,clusterOverride),m=amtl[resId];
  if(!m||weeklyPlanLower_(m.am_email)!==weeklyPlanLower_(user.email)||!weeklyPlanClusterMatch_(m.cluster,user.cluster))throw new Error('This restaurant is not mapped to the selected KAM.');
  var rows=ahmedabadReadPlanStore_(user.email),existing=null;
  rows.map(weeklyPlanObject_).some(function(p){if(String(p.resId)===resId&&['closed','met','cancelled','canceled'].indexOf(weeklyPlanLower_(p.status))<0){existing=p;return true;}return false;});
  if(existing&&!payload.moveExisting)return {ok:false,conflict:true,existing:{id:existing.id,date:existing.meetingDate,mode:existing.meetingType||existing.plannedMode||'Physical',status:existing.status}};
  // The picker already carries the latest calculated defaults. Reuse that
  // compact payload here instead of rebuilding the full portfolio a second
  // time; AMTL above remains the authority for ownership and location.
  var option={objective:String(payload.objective||''),talkingPoints:String(payload.talkingPoints||''),nextAction:String(payload.nextAction||''),priority:String(payload.priority||'P2'),priorityScore:weeklyPlanNumber_(payload.priorityScore)},brandIds=[];
  Object.keys(amtl).forEach(function(id){var outlet=amtl[id]||{};if(weeklyPlanLower_(outlet.am_email)===weeklyPlanLower_(user.email)&&weeklyPlanBrandKey_(outlet.res_name)===weeklyPlanBrandKey_(m.res_name))brandIds.push(String(id));});if(!brandIds.length)brandIds=[resId];option.brandResIds=brandIds;
  var savePayload=existing?existing:{};savePayload.id=existing?existing.id:'';savePayload.weekStart=weeklyPlanDate_(new Date());savePayload.meetingDate=date;savePayload.meetingTime='';savePayload.restaurant=String(m.res_name||option.restaurant||('Restaurant '+resId));savePayload.resId=resId;savePayload.city=String(m.city||option.city||'');savePayload.cluster=String(m.cluster||user.cluster||'');savePayload.status='Planned';savePayload.meetingType=mode;savePayload.latitude=m.latitude;savePayload.longitude=m.longitude;savePayload.source=existing?(existing.source||'Manual quick add'):'Manual quick add';
  savePayload.objective=existing&&existing.objective?existing.objective:option.objective;savePayload.talkingPoints=existing&&existing.talkingPoints?existing.talkingPoints:option.talkingPoints;savePayload.nextAction=existing&&existing.nextAction?existing.nextAction:option.nextAction;savePayload.priority=existing&&existing.priority?existing.priority:option.priority;savePayload.priorityScore=existing&&existing.priorityScore?existing.priorityScore:option.priorityScore;savePayload.brandResIds=option.brandResIds||[resId];savePayload.brandOutletLocations=(option.brandResIds||[resId]).map(function(id){var outlet=amtl[id]||{};return {id:String(id),name:String(outlet.res_name||savePayload.restaurant),mid:String(outlet.mid||''),chainId:String(outlet.chain_id||''),latitude:outlet.latitude,longitude:outlet.longitude};});savePayload.selectedResIds=[resId];savePayload.visitLocationType='Merchant outlets';
  var result=saveWeeklyPlan(savePayload,viewer,clusterOverride,viewAsKam),sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  // A moved or newly inserted field stop changes the route for the complete
  // day. Re-sequence from the KAM office; calls stay after field visits and
  // are ordered by score. This keeps the map and the card order consistent.
  weeklyPlanReorderDayRoutes_(sheet,user,[date]);
  var weekKey=(result.plan&&result.plan.weekStart)||weeklyPlanMonday_(date),plans=weeklyPlanRows_(user.email,weekKey),team=weeklyPlanTeamReview_(user,weekKey);
  ahmedabadWritePlanSnapshot_(user,weekKey,beatPilotWindow_(user,weekKey),plans,team);
  result.plans=plans;result.team=team;result.moved=!!existing;return result;
}

/**
 * Builds a data-backed weekly meeting map for the logged-in KAM.
 * Scheduling is deterministic: Current Week data is preferred, Current Month
 * is used only if the week feed has not yet been uploaded. AI is intentionally
 * not required to decide priority, so the plan remains reliable every Monday.
 */
function buildWeeklyPlanFromData(weekStart, viewer, clusterOverride, viewAsKam, routeStart) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  if (String(user.role || '').toLowerCase() !== 'kam') {
    throw new Error('Automatic weekly plans are created for a KAM portfolio. Use View as KAM to build a selected KAM’s plan.');
  }
  var monday = weeklyPlanDate_(new Date()); // Fresh builds always start today, never the selected historical week.
  weeklyPlanAutoCarryPastDue_(user, weeklyPlanMonday_(new Date()), clusterOverride, viewAsKam);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    // Reuse the KAM-scoped parsed portfolio JSON when its source signature is
    // unchanged. The signature already includes source file ids/timestamps, so
    // a new upload invalidates itself without re-reading every CSV on each build.
    var pilotPrefs=beatPilotPreferences_(user), pilotDates=beatPilotWindow_(user,monday);
    var source = weeklyPlanSourceRows_(user.email, clusterOverride);
    var candidates = weeklyPlanCandidates_(source.rows, user.email, clusterOverride, user.cluster, source.novRows || []);
    candidates.forEach(function(c){ if(c.metricSnapshot&&!c.metricSnapshot.basis)c.metricSnapshot.basis=source.label; });
    var book = weeklyPlanBook_(), sheet = book.getSheetByName(WEEKLY_PLAN_SHEET_);
    var rows = sheet.getDataRange().getValues(), keptBrand = {}, removeRows = [];
    for (var r=1; r<rows.length; r++) {
      var sameUser = String(rows[r][3] || '').toLowerCase() === user.email;
      var sameWeek = pilotDates.indexOf(weeklyPlanDate_(rows[r][2]))>=0;
      var autoPlan = String(rows[r][18] || '').toLowerCase() === 'automatic';
      var open = ['planned','follow-up'].indexOf(String(rows[r][15] || '').toLowerCase()) >= 0;
      if (sameUser && sameWeek && autoPlan && String(rows[r][15]||'').toLowerCase()==='planned' && !rows[r][29] && !rows[r][30] && !rows[r][34] && !rows[r][39] && !rows[r][40]) removeRows.push(r + 1);
      else if (sameUser && sameWeek && open && String(rows[r][6] || '')) keptBrand[weeklyPlanBrandKey_(rows[r][6])] = true;
    }
    // Regeneration must never remove a manually-made, completed, or closed
    // meeting. Delete only replaceable auto rows, from bottom to top.
    // Replacement is committed only after date/eligibility validation succeeds.
    // Date-only capacity is shared by generation and carry: 28 workload
    // units/day; a compact field visit uses four, a short call one.
    var slots = [];
    // Never back-fill a freshly built beat plan into days that are already
    // over. The rolling window includes the same weekday next week; Saturday
    // remains a lead-list sprint and Sunday is opt-in/manual only.
    var buildNow=new Date(),todayKey=weeklyPlanDate_(buildNow);
    // An evening refresh still shows today's plan/history, but a fresh build
    // must not create new work for an almost-finished day. After 18:00 local
    // time, assignment starts tomorrow while the eight-day board stays intact.
    var assignmentStartKey=buildNow.getHours()>=(Number(beatLogicValue_('evening_cutoff_hour'))||18)?weeklyPlanRepeatDay_(todayKey,1):todayKey;
    var today = new Date(todayKey+'T12:00:00');
    var mondayDate = new Date(monday + 'T12:00:00');
    var startDayIndex = 0;
    if (today > mondayDate) {
      startDayIndex = Math.floor((today.getTime() - mondayDate.getTime()) / 86400000);
    }
    if (startDayIndex < 0) startDayIndex = 0;
    if (startDayIndex > 4) startDayIndex = Math.max(5,startDayIndex);
    var remainingWeekdays = Math.max(0,5 - startDayIndex);
    // Every Ahmedabad beat starts from the mapped KAM office. Never silently
    // substitute a browser location because that would change every cluster.
    var start = weeklyPlanRouteStart_({latitude:user.officeLatitude,longitude:user.officeLongitude});
    if(!start)throw new Error('Office latitude/longitude is missing for this KAM in Master of Ahmedabad. Add the office coordinates before building the route.');
    // Route against the KAM's remembered brand meeting point, not an outlet
    // address that may be far from where the merchant actually meets them.
    candidates.forEach(function(c){var point=pilotPrefs.points[weeklyPlanBrandKey_(c.restaurant)];if(point){c.latitude=point.latitude;c.longitude=point.longitude;c.meetingPoint=point;}});
    // One route stop represents one brand visit. A KAM selects the individual
    // outlets covered during that visit in the field workflow.
    var retained=rows.slice(1).filter(function(row,index){return removeRows.indexOf(index+2)<0;});
    var assignments=weeklyPlanRepeatAssignments_(candidates,retained,user.email,monday,slots,start,assignmentStartKey,weeklyPlanDateTime_(buildNow).slice(-5),pilotDates,pilotPrefs.leaveDates);
    var selected=assignments.map(function(a){return a.candidate;});
    removeRows.sort(function(a,b){ return b-a; }).forEach(function(n){ sheet.deleteRow(n); });
    var created = [], weekdayCount = 0,routeCounts={};
    for (var i=0; i<selected.length; i++) {
      var date = new Date(assignments[i].date + 'T12:00:00');
      weekdayCount++;
      var c = selected[i], followUp = new Date(date.getTime()); followUp.setDate(followUp.getDate() + 2);
      var now = new Date();
      var record = [
        'WP-' + now.getTime() + '-' + Math.floor(Math.random()*10000) + '-' + i,
        weeklyPlanMonday_(date), weeklyPlanDate_(date), user.email, c.cluster || user.cluster || '', c.resId, c.restaurant, c.city,
        c.priority, assignments[i].time, c.objective, c.talkingPoints, '', c.nextAction,
        '', 'Planned', now, '', 'Automatic', c.score, c.rationale+'; Revisit: '+assignments[i].reason+'; Mode recommendation: '+assignments[i].recommendation,
        '', '', '', '', '', '',
        c.latitude == null ? '' : c.latitude, c.longitude == null ? '' : c.longitude, ''
      ];
      while (record.length < 42) record.push('');
      record.push('','', JSON.stringify(c.resIds || [c.resId]), JSON.stringify(c.outlets || []), '[]', 'Merchant outlets');
      record.push('','',c.meetingPoint?JSON.stringify(c.meetingPoint):'');
      while(record.length<56)record.push('');
      routeCounts[assignments[i].date]=(routeCounts[assignments[i].date]||0)+1;
      record.push(routeCounts[assignments[i].date], assignments[i].plannedMode||'Physical');
      sheet.appendRow(record); created.push(weeklyPlanObject_(record));
    }
    var builtPlans=weeklyPlanScopedRows_(user,monday),builtTeam=weeklyPlanTeamReview_(user,monday);
    ahmedabadWritePlanSnapshot_(user,monday,pilotDates,builtPlans,builtTeam);
    return {
      ok:true, weekStart:monday, dates:pilotDates, plans:builtPlans, team:builtTeam,
      summary:{generated:created.length, weekday:weekdayCount, weekend:0, source:source.label,
               sourceRows:source.rows.length,weekRows:source.weekRows||0,monthRows:source.monthRows||0,portfolioOutlets:candidates.portfolioOutlets||0,
               candidates:candidates.length,eligibleBrands:Object.keys(candidates.reduce(function(out,c){out[weeklyPlanBrandKey_(c.restaurant)||String(c.resId)]=true;return out;},{})).length,
               scheduledP0:selected.filter(function(c){return c.priority==='P0';}).length,
               dayAudit:assignments.dayAudit||[],
               weekendUsed:false,capacityUnits:weeklyPlanDailyCapacity_(),onsiteUnits:weeklyPlanVisitUnits_('Physical'),callUnits:weeklyPlanVisitUnits_('Call'),
               overflow:0,
               explanation:'Rolling eight calendar dates including next same weekday; weekends and leave are not auto-filled. On-site stops are selected from one compact meeting-point pocket per day, with calls in a separate queue. KAM may change meeting mode. Up to five nearby field visits are protected; calls can use all remaining capacity within 28 workload units. Due commitments and repeat rules still apply.',
               startDate:pilotDates[0],
               assignmentStartDate:assignmentStartKey,
               eveningBuild:assignmentStartKey!==todayKey,
               remainingWeekdays:pilotDates.filter(function(d){var day=new Date(d+'T12:00:00Z').getUTCDay();return day!==0&&day!==6&&pilotPrefs.leaveDates.indexOf(d)<0;}).length,
               mappedStops:selected.filter(function(c){ return c.latitude != null && c.longitude != null; }).length,
               routeStart:start}
    };
  } finally {
    try { lock.releaseLock(); } catch(ignore) {}
  }
}

/**
 * Converts a priority-ranked portfolio into compact city beats. Within a
 * city, P0 and highest-impact restaurants stay first; between cities, the
 * city with the highest unresolved impact is visited first. This deliberately
 * avoids pretending that we have GPS coordinates when the source only offers
 * city-level geography.
 */
function weeklyPlanRouteOrder_(candidates, dailyCapacity, routeStart) {
  // Build a real field route from AMTL coordinates. The next stop is the
  // closest eligible outlet, while P0/P1/P2 get a modest distance allowance
  // so a critical merchant is never pushed behind a low-impact nearby stop.
  var remaining = (candidates || []).slice(), route = [], current = routeStart || null;
  var priorityWeight = {P0:0, P1:12, P2:24};
  while (remaining.length) {
    var pick = -1, best = Infinity;
    for (var i=0; i<remaining.length; i++) {
      var c = remaining[i], hasCoord = c.latitude != null && c.longitude != null;
      var priorityKey = String(c.priority || 'P1');
      var priorityPenalty = Object.prototype.hasOwnProperty.call(priorityWeight, priorityKey) ? priorityWeight[priorityKey] : 12;
      var distance = current && hasCoord ? weeklyPlanHaversineKm_(current, c) : null;
      var value;
      if (distance !== null) value = distance + priorityPenalty;
      else if (hasCoord) value = 5000 + priorityPenalty - Math.min(99, weeklyPlanNumber_(c.score))/100;
      else value = 10000 + priorityPenalty - Math.min(99, weeklyPlanNumber_(c.score))/100;
      if (value < best || (value === best && weeklyPlanNumber_(c.score) > weeklyPlanNumber_(remaining[pick] && remaining[pick].score))) { best=value; pick=i; }
    }
    var next = remaining.splice(pick, 1)[0];
    if (current && next.latitude != null && next.longitude != null) next.routeDistanceKm = Math.round(weeklyPlanHaversineKm_(current,next)*10)/10;
    route.push(next);
    if (next.latitude != null && next.longitude != null) current = next;
  }
  return route;
}

/**
 * Create an editable Google Slides deck for a scheduled meeting.
 *
 * When the globally linked Colab endpoint supports `weekly_deck_package`, the
 * deck uses its English copy plus one generated visual.  The deterministic
 * deck below remains a safe fallback so an unavailable model never stops a
 * KAM from getting a useful deck.
 */
function createWeeklyPlanDeck(planId, viewer, clusterOverride, viewAsKam, forceRebuild) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  // A web-app may execute as its owner, while `viewer` is the person actually
  // requesting the deck. Share with both identities (and the mapped KAM) so
  // the deck remains editable after a dashboard refresh or View As session.
  var sessionEmail='';
  try { sessionEmail=Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || ''; } catch(sessionEmailIgnore) {}
  var sheet = weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows = sheet.getDataRange().getValues(), rowNo = -1, row = null;
  for (var r=1; r<rows.length; r++) {
    if (String(rows[r][0]) === String(planId) && String(rows[r][3] || '').toLowerCase() === user.email) { rowNo=r+1; row=rows[r]; break; }
  }
  if (!row) throw new Error('This meeting plan is not available for your account.');
  if (String(row[12] || '').trim() && !forceRebuild) {
    // Old decks may have been created before per-creator sharing was added.
    var existingShare = weeklyPlanDeckGrantCreatorAccess_(String(row[12]), [user.email, String(viewer || ''), sessionEmail, String(row[3] || '')]);
    return {ok:true, deckLink:String(row[12]), plan:weeklyPlanObject_(row), reused:true, sharing:existingShare};
  }
  var plan = weeklyPlanObject_(row), title = 'Brahmastra · ' + (plan.restaurant || 'Merchant meeting');
  // The deck must be based on the complete current restaurant scorecard, not
  // merely the short meeting objective saved in the tracker.
  try { plan.aiMetrics=weeklyPlanAiMetricsForPlan_(plan, user, clusterOverride); } catch(metricContextIgnore) { plan.aiMetrics={}; }
  var aiPackage = weeklyPlanAiDeckPackage_(plan, user);
  var deckContent = aiPackage.deck || weeklyPlanStaticDeckContent_(plan, user);
  var coverImage = weeklyPlanAiDeckImage_(aiPackage.imagePath, aiPackage.config);
  var visuals=[];
  try { visuals=weeklyPlanDeckVisuals_(plan, user, clusterOverride); } catch(visualLoadIgnore) {}
  var deck = SlidesApp.create(title), folder = weeklyPlanDeckFolder_();
  try {
    var file = DriveApp.getFileById(deck.getId()); folder.addFile(file);
    try { DriveApp.getRootFolder().removeFile(file); } catch(rootIgnore) {}
  } catch(folderIgnore) {}
  // The Apps Script owner creates the file, but the KAM/creator must be able
  // to open, present and edit the same deck from their own Drive account.
  var deckSharing = weeklyPlanDeckGrantCreatorAccess_(deck.getUrl(), [user.email, String(viewer || ''), sessionEmail, String(plan.kamEmail || row[3] || '')]);
  var first = deck.getSlides()[0];
  weeklyPlanDeckCoverSlide_(first, '#E23744', deckContent.cover || {}, plan, coverImage);
  if (visuals.length) weeklyPlanDeckPrioritySlide_(deck.appendSlide(SlidesApp.PredefinedLayout.BLANK), plan, visuals[0]);
  else weeklyPlanDeckExecutiveSlide_(deck.appendSlide(SlidesApp.PredefinedLayout.BLANK), plan);
  // The deck uses one fixed seven-slide story. AI writes the copy for the
  // three narrative pages only; it never changes the visual structure.
  (deckContent.slides || []).slice(0,3).forEach(function(spec, index) {
    weeklyPlanDeckSlide_(deck.appendSlide(SlidesApp.PredefinedLayout.BLANK), spec.accent || weeklyPlanDeckAccent_(index), spec.heading || 'Meeting focus', spec.bullets || [], index, plan, visuals);
  });
  // Keep one customer-behaviour visual page. This gives a rich presentation
  // without turning a merchant meeting into a long analytics report.
  try {
    var customerVisual=(visuals || []).filter(function(visual){ return visual.kind === 'segment'; })[0];
    weeklyPlanDeckCustomerStorySlide_(deck.appendSlide(SlidesApp.PredefinedLayout.BLANK), customerVisual, plan);
  } catch(visualIgnore) {}
  // The close-out page is deliberately last: it gives the KAM a clean, editable
  // screen to align on the merchant commitment before ending the meeting.
  weeklyPlanDeckCommitmentSlide_(deck.appendSlide(SlidesApp.PredefinedLayout.BLANK), plan, user);
  var link = deck.getUrl();
  sheet.getRange(rowNo,13).setValue(link);
  sheet.getRange(rowNo,17).setValue(new Date());
  row[12] = link; row[16] = new Date();
  return {ok:true, deckLink:link, plan:weeklyPlanObject_(row), plans:weeklyPlanRows_(user.email, row[1]), reused:false,
          aiDeck:!!aiPackage.usedAi, aiVisual:!!coverImage, deckWarning:aiPackage.warning || '', sharing:deckSharing};
}

function weeklyPlanDeckGrantCreatorAccess_(deckUrl, emails) {
  var match=String(deckUrl || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return {ok:false, directEditors:[], domainLinkEditor:false};
  var file;
  try {
    file=DriveApp.getFileById(match[1]);
  } catch(fileIgnore) {
    return {ok:false, directEditors:[], domainLinkEditor:false};
  }
  // Let a Zomato-domain recipient share the deck further when Workspace policy
  // allows it. Direct editor grants below still cover the deck creator.
  try { file.setShareableByEditors(true); } catch(shareableIgnore) {}
  var directEditors=[], errors=[], seen={};
  (Array.isArray(emails) ? emails : [emails]).forEach(function(rawEmail) {
    var email=String(rawEmail || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 1 || seen[email]) return;
    seen[email]=true;
    // Prefer the Advanced Drive permission API when it is enabled: it works
    // reliably for Slides created by a web-app owner. DriveApp is retained as
    // a fallback so this does not require a new service for existing projects.
    var granted=false;
    try {
      if (typeof Drive !== 'undefined' && Drive.Permissions && Drive.Permissions.create) {
        Drive.Permissions.create({type:'user', role:'writer', emailAddress:email}, match[1], {sendNotificationEmail:true});
        granted=true;
      }
    } catch(advancedDriveIgnore) { errors.push(email+': '+String(advancedDriveIgnore.message || advancedDriveIgnore)); }
    if (!granted) {
      try { file.addEditor(email); granted=true; } catch(editorIgnore) { errors.push(email+': '+String(editorIgnore.message || editorIgnore)); }
    }
    if (granted) directEditors.push(email);
  });
  // In some Workspace setups an individual addEditor call is blocked. The
  // deck is internal-only, so Zomato-domain users who have this dashboard link
  // get edit access as a safe fallback; it is never public on the web.
  var domainLinkEditor=false;
  try {
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
    domainLinkEditor=true;
  } catch(domainIgnore) { errors.push('Domain link: '+String(domainIgnore.message || domainIgnore)); }
  return {ok:directEditors.length>0 || domainLinkEditor, directEditors:directEditors, domainLinkEditor:domainLinkEditor, errors:errors};
}

function weeklyPlanSourceRows_(email, clusterOverride) {
  function load_(file){try{var feed=readForViewer_(email,file,clusterOverride);return feed&&feed.csv?csvToObjects_(feed.csv):[];}catch(ignore){return [];}}
  function mergeLatest_(monthly,weekly){
    var byId={},order=[];
    function add_(row,basis){var id=normId_(weeklyPlanPick_(row,['res_id','res id','restaurant_id','restaurant id']));if(!id)return;
      var period=String(weeklyPlanPick_(row,['time_period','time period'])||'');
      if(!byId[id])order.push(id);
      if(byId[id]&&byId[id].__beatBasis===basis&&weeklyPlanWeekSerial_(period)<weeklyPlanWeekSerial_(byId[id].__beatPeriod))return;
      var copy={};Object.keys(row).forEach(function(k){copy[k]=row[k];});copy.__beatBasis=basis;copy.__beatPeriod=period;byId[id]=copy;
    }
    (monthly||[]).forEach(function(row){add_(row,'Current Month');});
    (weekly||[]).forEach(function(row){add_(row,'Current Week');});
    return order.map(function(id){return byId[id];});
  }
  var signature=ahmedabadSourceSignature_([TABLE_WEEK_FILE,TABLE_CUR_FILE,NOV_FILE.week,NOV_FILE.month,AMTL_FILE]);
  var cached=ahmedabadReadJsonCache_('portfolio',email,signature);
  if(cached&&Array.isArray(cached.rows)&&Array.isArray(cached.novRows))return cached;
  var week=load_(TABLE_WEEK_FILE),month=load_(TABLE_CUR_FILE);
  if(!week.length&&!month.length)throw new Error('No Current Week or Current Month portfolio file is available yet for this KAM.');
  var novWeek=load_(NOV_FILE.week),novMonth=load_(NOV_FILE.month);
  var amtl=loadAmtl_(email,clusterOverride),want=weeklyPlanLower_(email);
  function owner_(row){
    var id=normId_(weeklyPlanPick_(row,['res_id','res id','restaurant_id','restaurant id'])),map=amtl[id]||{};
    return weeklyPlanLower_(weeklyPlanPick_(row,['am_email','kam_email','kam email','owner_email'])||map.am_email||'');
  }
  // Build and persist only the requested KAM's slice. A KAM refresh must not
  // fan out into hundreds of portfolio JSON files or rebuild another KAM's plan.
  function scope_(items){return (items||[]).filter(function(row){return owner_(row)===want;});}
  var scopedWeek=scope_(week),scopedMonth=scope_(month),scopedNovWeek=scope_(novWeek),scopedNovMonth=scope_(novMonth);
  var label=week.length&&month.length?'Latest Week + Month coverage':week.length?'Current Week':'Current Month';
  var result={rows:mergeLatest_(scopedMonth,scopedWeek),novRows:mergeLatest_(scopedNovMonth,scopedNovWeek),label:label,weekRows:scopedWeek.length,monthRows:scopedMonth.length};
  ahmedabadWriteJsonCache_('portfolio',want,signature,result);
  return result;
}

// Beat-plan category scoring is deliberately system-led (not user-configured).
// It combines business impact with the three controllable levers described in
// the Beat Planner recommendation: Ads, Promos and Customer Experience.
function weeklyPlanMean_(values) {
  var clean=(values || []).filter(function(v){ return v !== null && v !== undefined && isFinite(Number(v)); });
  if (!clean.length) return 0;
  return clean.reduce(function(sum,v){ return sum+Number(v); },0)/clean.length;
}
function weeklyPlanLowGap_(value, target) {
  value=Number(value); target=Number(target);
  if (!isFinite(value) || !isFinite(target) || target<=0) return null;
  return Math.max(0,Math.min(100,(target-value)/target*100));
}
function weeklyPlanHighGap_(value, limit) {
  value=Number(value); limit=Number(limit);
  if (!isFinite(value) || !isFinite(limit) || limit<=0) return null;
  return Math.max(0,Math.min(100,(value-limit)/limit*100));
}
function weeklyPlanCandidates_(rows, kamEmail, clusterOverride, defaultCluster, novRows) {
  var amtl = {};
  try { amtl = loadAmtl_(kamEmail, clusterOverride); } catch(ignore) {}
  var byRes = {};
  rows.forEach(function(row){
    var id = normId_(weeklyPlanPick_(row,['res_id','res id','restaurant_id','restaurant id']));
    if (!id) return;
    var map = amtl[id] || {}, owner = String(weeklyPlanPick_(row,['am_email','kam_email','kam email','owner_email']) || map.am_email || '').trim().toLowerCase();
    if (owner !== String(kamEmail).toLowerCase()) return;
    // current_week may carry multiple Time_Periods. Use only its latest bucket.
    var period = String(weeklyPlanPick_(row,['time_period','time period']) || '').trim();
    var old = byRes[id];
    if (old && weeklyPlanWeekSerial_(period) < weeklyPlanWeekSerial_(old.__period)) return;
    row.__period = period; byRes[id] = row;
  });
  var novByRes={};
  (novRows || []).forEach(function(row){ var rid=normId_(weeklyPlanPick_(row,['res_id','res id','restaurant_id','restaurant id'])); if (rid) novByRes[rid]=row; });
  // P0 must mean material business impact, not just a low percentage. Scale the
  // absolute target gap against this KAM's own portfolio before scheduling.
  var impactScale={novTarget:1,novGap:1,cmTarget:1,cmGap:1},impactValues={novTarget:[],novGap:[],cmTarget:[],cmGap:[]};
  Object.keys(byRes).forEach(function(id){
    var base=byRes[id], nov=novByRes[id] || {};
    var nt=weeklyPlanNumber_(weeklyPlanPick_(base,['nov_target','nov target','target_nov','absolute_nov_target','weekly_nov_target','week_nov_target']) || weeklyPlanPick_(nov,['nov_target','nov target','target_nov','absolute_nov_target','weekly_nov_target','week_nov_target']));
    var na=weeklyPlanNumber_(weeklyPlanPick_(base,['nov_actual','nov actual','actual_nov','nov','absolute_nov_actual','weekly_nov_actual','week_nov_actual']) || weeklyPlanPick_(nov,['nov_actual','nov actual','actual_nov','nov','absolute_nov_actual','weekly_nov_actual','week_nov_actual']));
    var ct=weeklyPlanNumber_(weeklyPlanPick_(base,['supply_cm_target','supply cm target','cm_target','cm target','target_cm','weekly_cm_target','week_cm_target']));
    var ca=weeklyPlanNumber_(weeklyPlanPick_(base,['supply_cm_actual','supply cm actual','cm_actual','cm actual','actual_cm','weekly_cm_actual','week_cm_actual']));
    if(nt>0)impactValues.novTarget.push(nt);if(nt-na>0)impactValues.novGap.push(nt-na);
    if(ct>0)impactValues.cmTarget.push(ct);if(ct-ca>0)impactValues.cmGap.push(ct-ca);
  });
  // A single outlier target must not disqualify the other ~200 restaurants.
  // Use the KAM portfolio's upper-decile reference, then cap the ratio.
  Object.keys(impactScale).forEach(function(key){var values=impactValues[key].sort(function(a,b){return a-b;});if(values.length)impactScale[key]=Math.max(1,values[Math.ceil(values.length*.90)-1]);});
  var candidates = Object.keys(byRes).map(function(id){
    var r=byRes[id], novRow=novByRes[id] || {}, map=amtl[id] || {};
    var novTargetRaw=weeklyPlanPick_(r,['nov_target','nov target','target_nov','absolute_nov_target','weekly_nov_target','week_nov_target']);
    var novActualRaw=weeklyPlanPick_(r,['nov_actual','nov actual','actual_nov','nov','absolute_nov_actual','weekly_nov_actual','week_nov_actual']);
    if (novTargetRaw==='' || novTargetRaw==null) novTargetRaw=weeklyPlanPick_(novRow,['nov_target','nov target','target_nov','absolute_nov_target','weekly_nov_target','week_nov_target']);
    if (novActualRaw==='' || novActualRaw==null) novActualRaw=weeklyPlanPick_(novRow,['nov_actual','nov actual','actual_nov','nov','absolute_nov_actual','weekly_nov_actual','week_nov_actual']);
    var novTarget=weeklyPlanNumber_(novTargetRaw), novActual=weeklyPlanNumber_(novActualRaw);
    var cmTarget=weeklyPlanNumber_(weeklyPlanPick_(r,['supply_cm_target','supply cm target','cm_target','cm target','target_cm','weekly_cm_target','week_cm_target'])), cmActual=weeklyPlanNumber_(weeklyPlanPick_(r,['supply_cm_actual','supply cm actual','cm_actual','cm actual','actual_cm','weekly_cm_actual','week_cm_actual']));
    // Several Brahmastra feeds keep related measures inside JSON cells.  Read
    // both direct columns and nested JSON so the meeting brief never falls
    // back to a NOV-only conversation just because a metric is nested.
    function metric_(aliases) { return weeklyPlanDeepPick_(r, aliases); }
    function metricPresent_(value) {
      return value !== '' && value !== null && value !== undefined && String(value).trim() !== '';
    }
    var expected=weeklyPlanNumber_(metric_(['expected','expected_visibility'])), actual=weeklyPlanNumber_(metric_(['actual','actual_visibility']));
    var rating=weeklyPlanNumber_(metric_(['rating','restaurant_rating'])), menu=weeklyPlanPercent_(metric_(['menu_score','menu score']));
    // Keep the meeting brief tied to the same restaurant-level Brahmastra
    // data the KAM sees on the dashboard; missing columns simply stay absent.
    var adsRevenue=weeklyPlanNumber_(metric_(['ads_rev','ad_rev','ads_revenue','ad_revenue','ads revenue','ad revenue']));
    var commissionableValue=weeklyPlanNumber_(metric_(['commissionable_value','commisionable_value','commissionable value','commissionable_cv','cv']));
    var directAdsCv=weeklyPlanPercent_(metric_(['ads_cv','ads/cv','current_ads_cv','ad_rev_cv','ad_rev/cv']));
    // Source of truth: Ads/CV = ads_rev / commissionable_value.
    var adsCv=commissionableValue>0 && adsRevenue>=0 ? adsRevenue/commissionableValue*100 : directAdsCv;
    var adsSv=weeklyPlanPercent_(metric_(['ads_sv','ads/sv','ads_sv_pc','ads/sv+pc','ad_rev_sv'])), targetAdsCv=weeklyPlanPercent_(metric_(['target_ads_cv','target ads/cv','ads_cv_target']));
    var mvdSv=weeklyPlanPercent_(metric_(['mvd_sv','mvd/sv','mvd_sv_pc','mvd/sv+pc','actual_mvd_sv','actual_mvd_sv_pc'])), intendedMvdSv=weeklyPlanPercent_(metric_(['intended_mvd_sv','intended_mvd_sv_pc','intended mvd/sv','target_mvd_sv']));
    var actualMshare=weeklyPlanPercent_(metric_(['actual_mshare','actual_merchant_share','actual merchant share','merchant_share_pct','mshare_pct','m_share_pct'])), intendedMshare=weeklyPlanPercent_(metric_(['intended_mshare','intended_merchant_share','intended merchant share','target_mshare','target_merchant_share']));
    var saltSv=weeklyPlanPercent_(metric_(['salt_sv','salt/sv','salt_sv_pc','salt/sv+pc'])), lmSaltSv=weeklyPlanPercent_(metric_(['lm_salt_sv','lm_salt_sv_pc','last_month_salt_sv','last month salt/sv']));
    var zvdSv=weeklyPlanPercent_(metric_(['zvd_sv','zvd/sv','zvd_sv_pc','zvd/sv+pc'])), lmZvdSv=weeklyPlanPercent_(metric_(['lm_zvd_sv','lm_zvd_sv_pc','last_month_zvd_sv','last month zvd/sv']));
    var lmAdsCv=weeklyPlanPercent_(metric_(['lm_ads_cv','last_month_ads_cv','last month ads/cv'])), lmMvdSv=weeklyPlanPercent_(metric_(['lm_mvd_sv','lm_mvd_sv_pc','last_month_mvd_sv','last month mvd/sv']));
    var l2mAdsCv=weeklyPlanPercent_(metric_(['l2m_ads_cv','last_2_month_ads_cv','two_month_ads_cv','l2m ads/cv'])), l2mMvdSv=weeklyPlanPercent_(metric_(['l2m_mvd_sv','l2m_mvd_sv_pc','last_2_month_mvd_sv','l2m mvd/sv']));
    var l2mSaltSv=weeklyPlanPercent_(metric_(['l2m_salt_sv','l2m_salt_sv_pc','last_2_month_salt_sv','l2m salt/sv'])), l2mZvdSv=weeklyPlanPercent_(metric_(['l2m_zvd_sv','l2m_zvd_sv_pc','last_2_month_zvd_sv','l2m zvd/sv']));
    var lmMshare=weeklyPlanPercent_(metric_(['lm_mshare','lm_merchant_share','last_month_mshare','last month merchant share'])), l2mMshare=weeklyPlanPercent_(metric_(['l2m_mshare','l2m_merchant_share','last_2_month_mshare','l2m merchant share']));
    function benchPct_(base,kind){return weeklyPlanPercent_(metric_([base+'_benchmark_'+kind,'benchmark_'+kind+'_'+base,base+' benchmark '+kind,'cuisine_city_'+base+'_'+kind,'cuisine_x_city_'+base+'_'+kind,base+'_peer_'+kind,'peer_'+kind+'_'+base]));}
    function benchNum_(base,kind){return weeklyPlanNumber_(metric_([base+'_benchmark_'+kind,'benchmark_'+kind+'_'+base,base+' benchmark '+kind,'cuisine_city_'+base+'_'+kind,'cuisine_x_city_'+base+'_'+kind,base+'_peer_'+kind,'peer_'+kind+'_'+base]));}
    var benchmarks={
      adsCv:{avg:benchPct_('ads_cv','avg'),max:benchPct_('ads_cv','max')},mvdSv:{avg:benchPct_('mvd_sv','avg'),max:benchPct_('mvd_sv','max')},saltSv:{avg:benchPct_('salt_sv','avg'),max:benchPct_('salt_sv','max')},
      mshare:{avg:benchPct_('mshare','avg')||benchPct_('merchant_share','avg'),max:benchPct_('mshare','max')||benchPct_('merchant_share','max')},i2m:{avg:benchPct_('i2m','avg'),max:benchPct_('i2m','max')},m2c:{avg:benchPct_('m2c','avg'),max:benchPct_('m2c','max')},c2o:{avg:benchPct_('c2o','avg'),max:benchPct_('c2o','max')},m2o:{avg:benchPct_('m2o','avg'),max:benchPct_('m2o','max')},
      adsRoi:{avg:benchNum_('ads_roi','avg'),max:benchNum_('ads_roi','max')}
    };
    var i2m=weeklyPlanPercent_(metric_(['i2m','impression_to_menu','impressions_to_menu'])), m2c=weeklyPlanPercent_(metric_(['m2c','menu_to_cart','menu_to_cart_rate'])), c2o=weeklyPlanPercent_(metric_(['c2o','cart_to_order','cart_to_order_rate'])), m2o=weeklyPlanPercent_(metric_(['m2o','menu_to_order','menu_to_order_rate']));
    var impressions=weeklyPlanNumber_(metric_(['impressions','impression'])), orderRaw=metric_(['total_orders','total orders','orders','order_makes','order makes']);
    var hasOrderData=orderRaw !== '' && orderRaw !== null && orderRaw !== undefined, orders=weeklyPlanNumber_(orderRaw);
    // Match the Portfolio deep-dive exactly: MVD OV and Salt OV are order
    // contributions, not raw percentages.  The CSV stores their numerators
    // (MVD orders / Salt orders), so divide them by restaurant total orders.
    var mvdOvOrders=weeklyPlanNumber_(metric_(['mvd_ov','mvd ov','mvd_orders','coded_orders','promo_orders']));
    var saltOrders=weeklyPlanNumber_(metric_(['salt_orders','salt orders','salt_ov_orders']));
    var codedOv=orders>0 && mvdOvOrders>0 ? mvdOvOrders/orders*100 : weeklyPlanPercent_(metric_(['mvd_ov_pct','coded_ov_pct']));
    var saltOv=orders>0 && saltOrders>0 ? saltOrders/orders*100 : weeklyPlanPercent_(metric_(['salt_ov_pct']));
    var discountOv=codedOv + saltOv;
    // Keep the full discount context visible in the merchant brief. These
    // are the same raw components surfaced in the restaurant deep-dive.
    var mvdAmt=weeklyPlanNumber_(metric_(['mvd','mvd_amt','mvd_amount','merchant_discount']));
    var zvdAmt=weeklyPlanNumber_(metric_(['zvd','zvd_amt','zvd_amount','zomato_discount']));
    var saltAmt=weeklyPlanNumber_(metric_(['salt','salt_amt','salt_amount']));
    var promoDiscount=weeklyPlanNumber_(metric_(['promo_discount','coded_discount','promo_discounts'])) || mvdAmt;
    var saltDiscount=weeklyPlanNumber_(metric_(['salt_discount','salt_discounts'])) || saltAmt;
    var totalDiscount=promoDiscount + saltDiscount + zvdAmt;
    // Every Beat ratio uses pure SV. PC is intentionally not part of the
    // denominator. Recalculate from absolutes whenever the feed supplies them.
    var supplyValue=weeklyPlanNumber_(metric_(['sv','supply_value','supply value'])), commissionRevenue=weeklyPlanNumber_(metric_(['commission_revenue','commission revenue']));
    if(supplyValue>0){if(mvdAmt>=0)mvdSv=mvdAmt/supplyValue*100;if(saltAmt>=0)saltSv=saltAmt/supplyValue*100;if(zvdAmt>=0)zvdSv=zvdAmt/supplyValue*100;if(adsRevenue>=0)adsSv=adsRevenue/supplyValue*100;}
    var commissionSv=supplyValue>0?commissionRevenue/supplyValue*100:null,walletShare=supplyValue>0?(commissionRevenue+adsRevenue+mvdAmt+saltAmt)/supplyValue*100:null,asv=orders>0?supplyValue/orders:null,acv=orders>0?commissionableValue/orders:null;
    // Customer-segmentation JSON contains counts. Convert them to total-order
    // shares just like the Portfolio popup does, with percentage fields only
    // as a fallback for older CSV layouts.
    var newOrders=weeklyPlanNumber_(metric_(['new_orders','new_order','new'])), repeatOrders=weeklyPlanNumber_(metric_(['repeat_orders','repeat_order','repeat'])), lapsedOrders=weeklyPlanNumber_(metric_(['lapsed_orders','lapsed_order','lapsed']));
    var pg710=weeklyPlanNumber_(metric_(['pg_7_10','pg7_10','pg_7_10_orders'])), pg46=weeklyPlanNumber_(metric_(['pg_4_6','pg46','pg_4_6_orders'])), pg13=weeklyPlanNumber_(metric_(['pg_1_3','pg13','pg_1_3_orders']));
    var breakfastOrders=weeklyPlanNumber_(metric_(['breakfast_orders','breakfast'])), lunchOrders=weeklyPlanNumber_(metric_(['lunch_orders','lunch'])), eveningOrders=weeklyPlanNumber_(metric_(['evening_orders','evening'])), dinnerOrders=weeklyPlanNumber_(metric_(['dinner_orders','dinner'])), lateNightOrders=weeklyPlanNumber_(metric_(['late_night_orders','late_night','late night']));
    var newMix=orders>0 && newOrders>0 ? newOrders/orders*100 : weeklyPlanPercent_(metric_(['new_pct','new_orders_pct','new_order_pct']));
    var repeatMix=orders>0 && repeatOrders>0 ? repeatOrders/orders*100 : weeklyPlanPercent_(metric_(['repeat_pct','repeat_orders_pct','repeat_order_pct']));
    var lapsedMix=orders>0 && lapsedOrders>0 ? lapsedOrders/orders*100 : weeklyPlanPercent_(metric_(['lapsed_pct','lapsed_orders_pct','lapsed_order_pct']));
    var pg710Mix=orders>0 && pg710>0 ? pg710/orders*100 : weeklyPlanPercent_(metric_(['pg_7_10_pct','pg710_pct']));
    var pg46Mix=orders>0 && pg46>0 ? pg46/orders*100 : weeklyPlanPercent_(metric_(['pg_4_6_pct','pg46_pct']));
    var pg13Mix=orders>0 && pg13>0 ? pg13/orders*100 : weeklyPlanPercent_(metric_(['pg_1_3_pct','pg13_pct']));
    var breakfastMix=orders>0 && breakfastOrders>0 ? breakfastOrders/orders*100 : weeklyPlanPercent_(metric_(['breakfast_pct','breakfast_orders_pct']));
    var lunchMix=orders>0 && lunchOrders>0 ? lunchOrders/orders*100 : weeklyPlanPercent_(metric_(['lunch_pct','lunch_orders_pct']));
    var eveningMix=orders>0 && eveningOrders>0 ? eveningOrders/orders*100 : weeklyPlanPercent_(metric_(['evening_pct','evening_orders_pct']));
    var dinnerMix=orders>0 && dinnerOrders>0 ? dinnerOrders/orders*100 : weeklyPlanPercent_(metric_(['dinner_pct','dinner_orders_pct']));
    var lateNightMix=orders>0 && lateNightOrders>0 ? lateNightOrders/orders*100 : weeklyPlanPercent_(metric_(['late_night_pct','late_night_orders_pct']));
    // Ads: penetration/delivery/traffic/return. Values can be direct CSV
    // fields or live inside the new JSON payloads.
    var adsOv=weeklyPlanNumber_(metric_(['ads_ov','ad_ov','ads_order_value','ad_order_value'])), totalOv=weeklyPlanNumber_(metric_(['ov','total_res_ov','total_order_value','order_value']));
    var adSpend=weeklyPlanNumber_(metric_(['adt','ad_spend','ads_spend','billed_ads','billed_amount','current_month_billed_amount']));
    var adImpressionsRaw=metric_(['ad_impressions','ads_impressions','ad impressions','ads impressions','total_ad_impressions','total ads impressions']);
    var adImpressions=weeklyPlanNumber_(adImpressionsRaw);
    var adsRoi=weeklyPlanNumber_(metric_(['ads_roi','ad_roi','roi']));
    if (adsRoi<=0 && adsOv>0 && adSpend>0) adsRoi=adsOv/adSpend;
    var adsOrderShare=totalOv>0 && adsOv>0 ? adsOv/totalOv*100 : null;
    var lmAdsOv=weeklyPlanNumber_(metric_(['lm_ads_ov','last_month_ads_ov','last_month_ad_ov'])), lmTotalOv=weeklyPlanNumber_(metric_(['lm_ov','last_month_ov','last_month_total_order_value']));
    var lmAdsOrderShare=lmTotalOv>0 && lmAdsOv>0 ? lmAdsOv/lmTotalOv*100 : null;
    // Promos: merchant co-funding, Zomato load and actual order adoption.
    var promoOrders=mvdOvOrders;
    var promoPenetration=orders>0 && promoOrders>0 ? promoOrders/orders*100 : null;
    var saltUtilisation=orders>0 && saltOrders>0 ? saltOrders/orders*100 : null;
    var mvdSaltSv=weeklyPlanPercent_(metric_(['mvd_salt_sv','mvd+salt/sv','mvd_salt_sv_pc','mvd+salt/sv+pc']));
    if(!mvdSaltSv && (mvdSv>0 || saltSv>0))mvdSaltSv=mvdSv+saltSv;
    var lmPromoOrders=weeklyPlanNumber_(metric_(['lm_promo_orders','last_month_promo_orders','lm_mvd_orders'])), lmOrders=weeklyPlanNumber_(metric_(['lm_orders','last_month_orders','last_month_total_orders']));
    var lmPromoPenetration=lmOrders>0 && lmPromoOrders>0 ? lmPromoOrders/lmOrders*100 : null;
    // CX: operational quality, refunds, menu content, retention and SLA.
    var mxRejections=weeklyPlanNumber_(metric_(['mx_rejections','merchant_rejections','rejections'])), kptDelayed=weeklyPlanNumber_(metric_(['kpt_delayed_orders','delayed_orders','kpt_delays']));
    var mxRefund=weeklyPlanNumber_(metric_(['mx_refund','merchant_refund','merchant_refunds'])), gmv=weeklyPlanNumber_(metric_(['gmv','gross_merchandise_value','gross_sales']));
    var rejectionRate=orders>0 && mxRejections>0 ? mxRejections/orders*100 : null, kptDelayRate=orders>0 && kptDelayed>0 ? kptDelayed/orders*100 : null, refundRate=gmv>0 && mxRefund>0 ? mxRefund/gmv*100 : null;
    var imageItems=weeklyPlanNumber_(metric_(['items_with_image','items_with_images','image_items'])), descriptionItems=weeklyPlanNumber_(metric_(['items_with_description','items_with_descriptions','description_items'])), totalItems=weeklyPlanNumber_(metric_(['total_items','menu_items','item_count','total_menu_items']));
    var itemsWithoutImage=weeklyPlanNumber_(metric_(['items_without_image','items_without_images','no_image'])),itemsWithoutDescription=weeklyPlanNumber_(metric_(['items_without_description','items_without_descriptions','no_description']));
    var imageScore=weeklyPlanPercent_(metric_(['image_score','image score'])),descriptionScore=weeklyPlanPercent_(metric_(['description_score','description score']));
    var thumbnailRaw=String(metric_(['thumbnail_image','thumbnail_image_flag','has_thumbnail_image','has_thumbnail','thumbnail_status','thumbnail'])||'').trim();
    var menuContentHealth=totalItems>0 ? (imageItems+descriptionItems)/(2*totalItems)*100 : null;
    var sdNum=weeklyPlanNumber_(metric_(['sd_num','serviceability_num'])), sdDen=weeklyPlanNumber_(metric_(['sd_den','serviceability_den'])), slNum=weeklyPlanNumber_(metric_(['sl_num','sla_num'])), slDen=weeklyPlanNumber_(metric_(['sl_den','sla_den']));
    var serviceability=(sdDen>0 || slDen>0) ? weeklyPlanMean_([sdDen>0 ? sdNum/sdDen*100 : null,slDen>0 ? slNum/slDen*100 : null]) : null;
    var priceFlag=String(metric_(['price_disparity','price disparity','price_parity_flag','menu_price_disparity']) || '').toLowerCase();
    var operatingFlags={
      pe:String(metric_(['pe_flag','p.e. flag','pe flag','price_elasticity_flag'])||''),ads:String(metric_(['ads_flag','ads flag'])||''),ar:String(metric_(['ar_flag','ar flag'])||''),
      gm1:String(metric_(['gm1','gm_1','grow_max_1','grow max 1','grow maxxx 1'])||''),gm2:String(metric_(['gm2','gm_2','grow_max_2','grow max 2','grow maxxx 2'])||''),gm3:String(metric_(['gm3','gm_3','grow_max_3','grow max 3','grow maxxx 3'])||''),sgm:String(metric_(['sgm','super_grow_max','super grow max'])||''),
      mvd:String(metric_(['mvd_flag','mvd live','mvd_status'])||''),salt:String(metric_(['salt_flag','salt live','salt_status'])||''),vegType:String(metric_(['veg_type','veg type','food_type','food type'])||''),cartBreaker:String(metric_(['cart_breaker','cart breaker','cart_breaker_type'])||'')
    };
    var gmaxxModel=String(metric_(['gmaxx_model','gmax_model','grow_maxxx_model','grow_maxx_model','growmaxxmodel','grow_max_model','grow maxxx model'])||'');
    var gmaxxX=weeklyPlanPercent_(metric_(['grow_maxx_x_percent','grow maxx x percent','gmaxx_x_percent'])),gmaxxY=weeklyPlanPercent_(metric_(['grow_maxx_y_percent','grow maxx y percent','gmaxx_y_percent']));
    var adsDeliveryRaw=metric_(['effective_ads_delivery','effective ads delivery','delivery_percent','delivery percentage','ads_delivery','ads_delivery_pct','ads delivery percent']);
    var adsDelivery=weeklyPlanPercent_(adsDeliveryRaw),billedAds=weeklyPlanNumber_(metric_(['total_billing','billed_ads','billed ads'])),bauBilling=weeklyPlanNumber_(metric_(['bau_billing','billed_ads_bau'])),gmBilling=weeklyPlanNumber_(metric_(['gm_billing','billed_ads_gm'])),adsCpc=weeklyPlanNumber_(metric_(['cpc','ads_cpc'])),adOrders=weeklyPlanNumber_(metric_(['ad_orders','ads_orders']));
    var hasAdsDelivery=metricPresent_(adsDeliveryRaw);
    var hasActiveAds=adsRevenue>0 || adSpend>0 || billedAds>0 || adImpressions>0 || adOrders>0 || adsRoi>0;
    if(!gmaxxModel){var activeGm=[];[['GM1',operatingFlags.gm1],['GM2',operatingFlags.gm2],['GM3',operatingFlags.gm3],['SGM',operatingFlags.sgm]].forEach(function(x){if(String(x[1]||'').trim()&&!/^(0|no|false|inactive)$/i.test(String(x[1])))activeGm.push(x[0]);});gmaxxModel=activeGm.join(' + ');}
    var novAch=novTarget>0 ? novActual/novTarget*100 : null, cmAch=cmTarget>0 ? cmActual/cmTarget*100 : null;
    var novGap=Math.max(0,novTarget-novActual), cmGap=Math.max(0,cmTarget-cmActual);
    var visibility=expected>0 ? actual/expected*100 : null, score=0, reasons=[], points=[], actionSignals=[];
    function addAction_(weight, category, reason, talk, action){ score+=weight; reasons.push(category+': '+reason); points.push('['+category+'] '+talk); actionSignals.push({weight:weight,category:category,text:action}); }
    // NOV/CM remain internal prioritisation signals only. Merchant-facing
    // briefs, calendar events and decks never expose their values or targets.
    function addInternalSignal_(weight){ score+=weight; }
    if (novAch !== null && novAch<70) addInternalSignal_(75);
    else if (novAch !== null && novAch<90) addInternalSignal_(42);
    else if (novAch !== null && novAch<100) addInternalSignal_(20);
    if (cmAch !== null && cmAch<70) addInternalSignal_(55);
    else if (cmAch !== null && cmAch<90) addInternalSignal_(30);
    // Zero-order / inactive restaurants belong to activation lead lists, not
    // to an in-person beat plan. They are intentionally excluded below.
    if (visibility !== null && visibility<95) addAction_(25,'Hygiene','Visibility is below 95%','Visibility is '+weeklyPlanFmtPct_(visibility)+' ('+weeklyPlanFmtNum_(actual)+' actual vs '+weeklyPlanFmtNum_(expected)+' expected). Resolve the availability / listing blocker.','Restore visibility to at least 95%.');
    if (rating>0 && rating<4) addAction_(15,'Hygiene','Rating is below 4.0','Rating is '+rating.toFixed(1)+'. Agree the customer-experience fix, owner and review date.','Improve rating through a concrete customer-experience fix.');
    if (menu>0 && menu<80) addAction_(15,'Hygiene','Menu score is below 80%','Menu score is '+weeklyPlanFmtPct_(menu)+'. Add missing images and descriptions for the priority menu items.','Lift menu score through menu hygiene completion.');
    if (targetAdsCv>0 && adsCv<targetAdsCv) addAction_(18,'Ads','Ads/CV is below its target','Ads/CV is '+weeklyPlanFmtPct_(adsCv)+(adsSv>0?' and Ads/SV is '+weeklyPlanFmtPct_(adsSv):'')+' vs Ads/CV target '+weeklyPlanFmtPct_(targetAdsCv)+'. Confirm budget and delivery actions.','Lift Ads/CV to the approved target.');
    else if (lmAdsCv>0 && adsCv<lmAdsCv) addAction_(12,'Ads','Ads/CV is below LM','Ads/CV is '+weeklyPlanFmtPct_(adsCv)+' vs LM '+weeklyPlanFmtPct_(lmAdsCv)+'. Diagnose delivery, budget and return before increasing spend.','Increase Ads/CV toward the supported recent level.');
    if (intendedMvdSv>0 && mvdSv<intendedMvdSv) addAction_(18,'Promos','MVD/SV is below intended','MVD/SV is '+weeklyPlanFmtPct_(mvdSv)+' vs intended '+weeklyPlanFmtPct_(intendedMvdSv)+'. Discuss the offer needed to close the supported gap.','Activate the approved MVD/SV offer improvement.');
    else if (lmMvdSv>0 && mvdSv<lmMvdSv) addAction_(12,'Promos','MVD/SV is below LM','MVD/SV is '+weeklyPlanFmtPct_(mvdSv)+' vs LM '+weeklyPlanFmtPct_(lmMvdSv)+'. Validate offer depth, merchant participation and recovery plan.','Increase MVD/SV toward the recent supported level.');
    if (lmSaltSv>0 && saltSv<lmSaltSv) addAction_(10,'Promos','Salt/SV is below LM','Salt/SV is '+weeklyPlanFmtPct_(saltSv)+' vs LM '+weeklyPlanFmtPct_(lmSaltSv)+'. Validate promo participation and recovery plan.','Increase Salt/SV toward the recent supported level.');
    if (intendedMshare>0 && actualMshare<intendedMshare) addAction_(12,'Sharing','Merchant share is below intended','Merchant share is '+weeklyPlanFmtPct_(actualMshare)+' vs intended '+weeklyPlanFmtPct_(intendedMshare)+'. Agree the supported co-funding correction.','Move merchant share toward the intended mix.');
    if (lmZvdSv>0 && zvdSv>lmZvdSv) addAction_(10,'Discounts','ZVD/SV has increased','ZVD/SV is '+weeklyPlanFmtPct_(zvdSv)+' vs LM '+weeklyPlanFmtPct_(lmZvdSv)+'. Reduce avoidable subsidy load while protecting conversion.','Reduce ZVD/SV to the recent supported level.');
    if (i2m>0 && i2m<15) addAction_(10,'Funnel','I2M is weak','I2M is '+weeklyPlanFmtPct_(i2m)+'. Review thumbnail, rating and first-menu-screen conversion.','Improve the impression-to-menu journey.');
    if (m2c>0 && m2c<20) addAction_(10,'Funnel','M2C is weak','M2C is '+weeklyPlanFmtPct_(m2c)+'. Improve menu score, images, descriptions and offer clarity.','Improve menu-to-cart conversion.');
    if (c2o>0 && c2o<15) addAction_(10,'Funnel','C2O is weak','C2O is '+weeklyPlanFmtPct_(c2o)+'. Review checkout friction, pricing and discount relevance.','Improve cart-to-order conversion.');
    if (priceFlag && priceFlag!=='0' && priceFlag!=='no' && priceFlag!=='false') addAction_(22,'Pricing','Price disparity is flagged','Price disparity is flagged. Review menu-price alignment and agree correction ownership.','Resolve the flagged menu-price disparity.');
    if (adsRoi>0 && adsRoi<2.5) addAction_(12,'Ads','Ads ROI is below 2.5','Ads ROI is '+adsRoi.toFixed(2)+'. Fix campaign targeting, creatives and delivery quality before increasing the budget.','Improve Ads ROI before adding incremental spend.');
    if (adsOrderShare!==null && adsOrderShare<5) addAction_(8,'Ads','Ad order share is low','Ads contributes '+weeklyPlanFmtPct_(adsOrderShare)+' of order value. Validate coverage and return before scaling.','Improve productive ads penetration and order share.');
    if (hasActiveAds && hasAdsDelivery && adsDelivery<90) addAction_(9,'Ads','Ads delivery is below 90%','Ads delivery is '+weeklyPlanFmtPct_(adsDelivery)+'. Resolve budget, targeting or inventory delivery blockers.','Restore ads delivery from '+weeklyPlanFmtPct_(adsDelivery)+' toward at least 90%.');
    if (promoPenetration!==null && promoPenetration<10) addAction_(10,'Promos','Promo penetration is low','Promo orders are '+weeklyPlanFmtPct_(promoPenetration)+' of order makes. Review the right promo mechanic and merchant participation.','Increase promo adoption on relevant customer cohorts.');
    if (saltUtilisation!==null && saltUtilisation<5) addAction_(8,'Promos','Salt utilisation is low','Salt orders are '+weeklyPlanFmtPct_(saltUtilisation)+' of order makes. Confirm eligibility and offer visibility.','Improve Salt utilisation for eligible demand.');
    if (zvdSv>0 && mvdSv>0 && zvdSv>mvdSv) addAction_(12,'Promos','Zomato discount load is high relative to MVD','ZVD/SV is '+weeklyPlanFmtPct_(zvdSv)+' while MVD/SV is '+weeklyPlanFmtPct_(mvdSv)+'. Rebalance merchant co-funding and subsidy load.','Reduce ZVD dependence while improving merchant-funded offers.');
    if (rejectionRate!==null && rejectionRate>2) addAction_(10,'Customer Experience','Merchant rejection rate is high','Merchant rejections are '+weeklyPlanFmtPct_(rejectionRate)+' of order makes. Diagnose availability and acceptance blockers.','Improve merchant acceptance and operational controls with a named owner.');
    if (kptDelayRate!==null && kptDelayRate>5) addAction_(10,'Customer Experience','KPT delayed rate is high','KPT delayed orders are '+weeklyPlanFmtPct_(kptDelayRate)+' of order makes. Agree kitchen throughput and prep-time corrections.','Improve on-time kitchen performance.');
    if (refundRate!==null && refundRate>1) addAction_(10,'Customer Experience','Merchant refund rate is elevated','Merchant refunds are '+weeklyPlanFmtPct_(refundRate)+' of GMV. Review root causes and closure actions.','Improve root-cause controls for merchant refunds.');
    if (menuContentHealth!==null && menuContentHealth<80) addAction_(10,'Customer Experience','Menu content health is below 80%','Menu content health is '+weeklyPlanFmtPct_(menuContentHealth)+'. Complete images and descriptions on missing items.','Lift menu content health above 80%.');
    if (thumbnailRaw && /^(0|no|n|false|missing)$/i.test(thumbnailRaw)) addAction_(8,'Hygiene','Thumbnail is missing','The restaurant thumbnail is not live. Add a compliant discovery image and confirm visibility.','Publish the restaurant thumbnail.');
    if (itemsWithoutImage>0 || itemsWithoutDescription>0) addAction_(Math.min(12,4+itemsWithoutImage+itemsWithoutDescription),'Hygiene','Menu assets are incomplete','Menu has '+weeklyPlanFmtNum_(itemsWithoutImage)+' items without images and '+weeklyPlanFmtNum_(itemsWithoutDescription)+' without descriptions.','Close the menu image and description gaps.');
    if (lapsedMix>15) addAction_(8,'Customer Experience','Lapsed customer mix is high','Lapsed mix is '+weeklyPlanFmtPct_(lapsedMix)+'. Use a targeted reactivation offer and experience recovery plan.','Reactivate lapsed customers with a measurable offer plan.');
    if (serviceability!==null && serviceability<95) addAction_(10,'Customer Experience','Serviceability/SLA is below 95%','Serviceability is '+weeklyPlanFmtPct_(serviceability)+'. Validate availability, delivery settings and SLA blockers.','Restore serviceability/SLA to at least 95%.');
    // Fixed beat-plan logic. Each category is calculated only from populated
    // metrics, so incomplete CSVs do not produce false alerts.
    var adsGap=weeklyPlanMean_([
      targetAdsCv>0 ? weeklyPlanLowGap_(adsCv,targetAdsCv) : (lmAdsCv>0 ? weeklyPlanLowGap_(adsCv,lmAdsCv) : null),
      adsRoi>0 ? weeklyPlanLowGap_(adsRoi,2.5) : null,
      adsOrderShare!==null ? weeklyPlanLowGap_(adsOrderShare,5) : null,
      hasActiveAds && hasAdsDelivery ? weeklyPlanLowGap_(adsDelivery,90) : null,
      (adsOrderShare!==null && lmAdsOrderShare!==null) ? weeklyPlanLowGap_(adsOrderShare,lmAdsOrderShare) : null
    ]);
    var promoGap=weeklyPlanMean_([
      lmZvdSv>0 ? weeklyPlanHighGap_(zvdSv,lmZvdSv) : null,
      promoPenetration!==null ? weeklyPlanLowGap_(promoPenetration,10) : null,
      intendedMvdSv>0 ? weeklyPlanLowGap_(mvdSv,intendedMvdSv) : (lmMvdSv>0 ? weeklyPlanLowGap_(mvdSv,lmMvdSv) : null),
      intendedMshare>0 ? weeklyPlanLowGap_(actualMshare,intendedMshare) : null,
      (zvdSv>0 && (intendedMvdSv>0 ? mvdSv<intendedMvdSv : (lmMvdSv>0 && mvdSv<lmMvdSv))) ? weeklyPlanHighGap_(zvdSv,Math.max(1,lmZvdSv || zvdSv*0.7)) : null,
      saltUtilisation!==null ? weeklyPlanLowGap_(saltUtilisation,5) : (lmSaltSv>0 ? weeklyPlanLowGap_(saltSv,lmSaltSv) : null),
      (promoPenetration!==null && lmPromoPenetration!==null) ? weeklyPlanLowGap_(promoPenetration,lmPromoPenetration) : null
    ]);
    var cxGap=weeklyPlanMean_([
      rating>0 ? weeklyPlanLowGap_(rating,4) : null,
      rejectionRate!==null ? weeklyPlanHighGap_(rejectionRate,2) : null,
      kptDelayRate!==null ? weeklyPlanHighGap_(kptDelayRate,5) : null,
      refundRate!==null ? weeklyPlanHighGap_(refundRate,1) : null,
      menuContentHealth!==null ? weeklyPlanLowGap_(menuContentHealth,80) : (menu>0 ? weeklyPlanLowGap_(menu,80) : null),
      visibility!==null ? weeklyPlanLowGap_(visibility,95) : null,
      serviceability!==null ? weeklyPlanLowGap_(serviceability,95) : null
    ]);
    var funnelGap=weeklyPlanMean_([i2m>0?weeklyPlanLowGap_(i2m,15):null,m2c>0?weeklyPlanLowGap_(m2c,20):null,c2o>0?weeklyPlanLowGap_(c2o,15):null]);
    var segmentGap=weeklyPlanMean_([repeatMix>0?weeklyPlanLowGap_(repeatMix,50):null,lapsedMix>0?weeklyPlanHighGap_(lapsedMix,15):null]);
    var beatGap=weeklyPlanWeightedMetricScore_({ads:adsGap,promos:promoGap,funnel:funnelGap,hygiene:cxGap,segmentation:segmentGap});
    if (beatGap>=10) {
      score+=beatGap;
      reasons.push('Metric weights: Ads 35%, Promos/Discounts 30%, Funnel 15%, Hygiene 10%, Customer segmentation 10%. Gaps: '+[adsGap,promoGap,funnelGap,cxGap,segmentGap].map(weeklyPlanFmtPct_).join(' / '));
      if (adsGap>=25) points.push('[Ads] Check Ads/CV, delivery, ROI, order share, coverage and Grow Max before committing incremental spend.');
      if (promoGap>=25) points.push('[Promos] Review promo adoption, merchant co-funding, ZVD load and Salt utilisation.');
      if (cxGap>=25) points.push('[Customer Experience] Review rating, rejection/KPT/refund rates, menu health, retention and serviceability.');
    }
    if (!score) return null;
    var impactScore=(novGap>0 ? 35*Math.min(1,novGap/impactScale.novGap) + 10*Math.min(1,novTarget/impactScale.novTarget) : 0) + (cmGap>0 ? 25*Math.min(1,cmGap/impactScale.cmGap) + 8*Math.min(1,cmTarget/impactScale.cmTarget) : 0);
    if (impactScore>0) {
      score+=impactScore;
      reasons.unshift('Internal commercial impact has been assessed from the latest portfolio signals.');
    }
    // Rank with both internal business impact and actionable merchant levers.
    // Ads/promos retain their higher weights inside beatGap; missing fields
    // never become invented zero-valued problems.
    score=Math.round(beatGap*.65+impactScore*.45);
    // Select from the whole active portfolio. The previous requirement that
    // BOTH target and gap exceed a fixed share of the single largest outlet
    // silently removed most restaurants from large KAM books.
    var activeRestaurant=(hasOrderData ? orders>0 : (novActual>0 || cmActual>0));
    var trendOrMetricIssue=beatGap>=12 ||
      (lmAdsCv>0 && adsCv<lmAdsCv) || (lmMvdSv>0 && mvdSv<lmMvdSv) ||
      (lmSaltSv>0 && saltSv<lmSaltSv) || (lmZvdSv>0 && zvdSv>lmZvdSv) ||
      (visibility!==null && visibility<95) || (rating>0 && rating<4) ||
      (menu>0 && menu<80) || (i2m>0 && i2m<15) || (m2c>0 && m2c<20) || (c2o>0 && c2o<15);
    var evidencedCommercialNeed=novGap>0 || cmGap>0 || adsGap>=12 || promoGap>=12;
    if (!activeRestaurant || !trendOrMetricIssue || !evidencedCommercialNeed) return null;
    var priority=score>=20?'P1':'P2';
    var restaurant=String(weeklyPlanPick_(r,['res_name','res name','restaurant_name','restaurant name']) || map.res_name || ('Restaurant '+id));
    var city=String(weeklyPlanPick_(r,['city','city_name','city name']) || map.city || '');
    var cluster=String(weeklyPlanPick_(r,['city_cluster','city cluster','cluster']) || map.cluster || defaultCluster || '');
    var mid=String(map.mid || weeklyPlanPick_(r,['mid','merchant_id','merchant id']) || '').trim();
    var chainId=String(map.chain_id || weeklyPlanPick_(r,['chain_id','chain id','chainid']) || '').trim();
    // The objective is merchant-facing and always has exactly three scannable
    // outcomes: Ads, Promos, and the strongest remaining business lever.
    var categoryOrder={'Ads':0,'Promos':1,'Discounts':1,'Funnel':2,'Pricing':2,'Hygiene':3,'Customer Experience':4,'Sharing':5};
    var rankedSignals=actionSignals.slice().sort(function(a,b){
      var ar=categoryOrder[a.category]==null?9:categoryOrder[a.category], br=categoryOrder[b.category]==null?9:categoryOrder[b.category];
      return b.weight-a.weight || ar-br;
    });
    function bestSignal_(categories){
      for(var si=0;si<rankedSignals.length;si++)if(categories.indexOf(rankedSignals[si].category)>=0)return rankedSignals[si];
      return null;
    }
    var adsSignal=bestSignal_(['Ads']) || {category:'Ads',text:hasActiveAds?'Review Ads/CV, delivery, ROI, order contribution and Grow Max; agree one supported ads action.':'Confirm the current ads opportunity and agree whether an evidence-backed ads action is applicable.'};
    var promoSignal=bestSignal_(['Promos','Discounts','Sharing']) || {category:'Promos',text:'Review MVD/SV, Salt/SV, promo order contribution and merchant funding; agree one supported promo action.'};
    var otherSignal=null;
    rankedSignals.some(function(signal){if(['Ads','Promos','Discounts','Sharing'].indexOf(signal.category)<0){otherSignal=signal;return true;}return false;});
    otherSignal=otherSignal || {category:'Commitment',text:'Close one measurable merchant commitment with a named owner and due date.'};
    var chosenSignals=[adsSignal,promoSignal,otherSignal];
    var objective=chosenSignals.map(function(signal,index){return (index+1)+'. '+signal.text;}).join('\n');
    points.sort(function(a,b){function rank(s){var m=s.match(/^\[([^\]]+)\]/);return m&&categoryOrder[m[1]]!=null?categoryOrder[m[1]]:5;}return rank(a)-rank(b);});
    if (!objective) objective='1. Review the strongest Ads lever.\n2. Review the strongest Promo lever.\n3. Agree one measurable merchant commitment with owner and due date.';
    if (impressions>0 && !points.length) points.push('Impressions are '+weeklyPlanFmtNum_(impressions)+'. Identify the highest-impact traffic or conversion blocker with the merchant.');
    points.push('Agree one measurable merchant commitment, named owner and due date before the meeting ends.');
    points=points.slice(0,6);
    var latitude = map.latitude;
    if (latitude == null) latitude = weeklyPlanLatitude_(weeklyPlanPick_(r,['res_latitude','res latitude','latitude','lat']));
    var longitude = map.longitude;
    if (longitude == null) longitude = weeklyPlanLongitude_(weeklyPlanPick_(r,['res_longitude','res longitude','longitude','lng','lon']));
    var aiMetrics=weeklyPlanAiMetricPack_(r,novRow,map);aiMetrics.canonical=aiMetrics.canonical||{};
    aiMetrics.canonical.ads_cv=adsCv;aiMetrics.canonical.ads_roi=adsRoi;aiMetrics.canonical.ad_order_pct=adsOrderShare;aiMetrics.canonical.gmaxx_model=gmaxxModel;
    aiMetrics.canonical.mvd_sv=mvdSv;aiMetrics.canonical.intended_mvd_sv=intendedMvdSv;aiMetrics.canonical.lm_mvd_sv=lmMvdSv;aiMetrics.canonical.l2m_mvd_sv=l2mMvdSv;aiMetrics.canonical.salt_sv=saltSv;aiMetrics.canonical.lm_salt_sv=lmSaltSv;aiMetrics.canonical.l2m_salt_sv=l2mSaltSv;aiMetrics.canonical.mvd_salt_sv=mvdSaltSv;aiMetrics.canonical.promo_order_pct=promoPenetration;
    aiMetrics.canonical.actual_merchant_share_pct=actualMshare;aiMetrics.canonical.intended_merchant_share_pct=intendedMshare;aiMetrics.canonical.lm_merchant_share_pct=lmMshare;aiMetrics.canonical.l2m_merchant_share_pct=l2mMshare;
    aiMetrics.canonical.lm_ads_cv=lmAdsCv;aiMetrics.canonical.l2m_ads_cv=l2mAdsCv;aiMetrics.canonical.lm_zvd_sv=lmZvdSv;aiMetrics.canonical.l2m_zvd_sv=l2mZvdSv;aiMetrics.canonical.cuisine_city_benchmarks=benchmarks;
    aiMetrics.canonical.visibility=visibility;aiMetrics.canonical.kpt_delay_pct=kptDelayRate;aiMetrics.canonical.rejection_pct=rejectionRate;aiMetrics.canonical.rating=rating;aiMetrics.canonical.m2o=m2o;aiMetrics.canonical.m2c=m2c;aiMetrics.canonical.c2o=c2o;
    return {resId:id,restaurant:restaurant,city:city,cluster:cluster,mid:mid,chainId:chainId,priority:priority,score:Math.round(score),rationale:reasons.join('; '),objective:objective,talkingPoints:points.join('\n'),nextAction:'KAM to record both KAM and merchant commitments with due dates.',latitude:latitude,longitude:longitude,briefCards:weeklyPlanBriefCards_({novTarget:novTarget,novActual:novActual,novAch:novAch,cmTarget:cmTarget,cmActual:cmActual,cmAch:cmAch,orders:orders,visibility:visibility,expected:expected,actual:actual,rating:rating,menu:menu,adsCv:adsCv,adsSv:adsSv,targetAdsCv:targetAdsCv,lmAdsCv:lmAdsCv,l2mAdsCv:l2mAdsCv,adsRoi:adsRoi,adsOrderShare:adsOrderShare,gmaxxModel:gmaxxModel,mvdSv:mvdSv,intendedMvdSv:intendedMvdSv,lmMvdSv:lmMvdSv,l2mMvdSv:l2mMvdSv,actualMshare:actualMshare,intendedMshare:intendedMshare,lmMshare:lmMshare,l2mMshare:l2mMshare,saltSv:saltSv,lmSaltSv:lmSaltSv,l2mSaltSv:l2mSaltSv,mvdSaltSv:mvdSaltSv,saltUtilisation:saltUtilisation,promoPenetration:promoPenetration,zvdSv:zvdSv,lmZvdSv:lmZvdSv,l2mZvdSv:l2mZvdSv,i2m:i2m,m2o:m2o,m2c:m2c,c2o:c2o,benchmarks:benchmarks,codedOv:codedOv,saltOv:saltOv,discountOv:discountOv,promoDiscount:promoDiscount,saltDiscount:saltDiscount,zvdDiscount:zvdAmt,totalDiscount:totalDiscount,newMix:newMix,repeatMix:repeatMix,lapsedMix:lapsedMix,pg710Mix:pg710Mix,pg46Mix:pg46Mix,pg13Mix:pg13Mix,breakfastMix:breakfastMix,lunchMix:lunchMix,eveningMix:eveningMix,dinnerMix:dinnerMix,lateNightMix:lateNightMix,rejectionRate:rejectionRate,kptDelayRate:kptDelayRate,refundRate:refundRate,menuContentHealth:menuContentHealth,serviceability:serviceability,priceFlag:priceFlag,operatingFlags:operatingFlags}),aiMetrics:aiMetrics};
  }).filter(function(x){return !!x;});
  weeklyPlanPromoteP0Brands_(candidates);
  candidates.sort(function(a,b){var p={P0:0,P1:1,P2:2};return p[a.priority]-p[b.priority]||b.score-a.score||a.restaurant.localeCompare(b.restaurant);});
  candidates.forEach(function(c){var row=byRes[c.resId]||{};c.metricSnapshot=weeklyPlanSnapshot_(row,row.__beatBasis||'');});
  candidates.portfolioOutlets=Object.keys(byRes).length;
  return candidates;
}
function weeklyPlanPromoteP0Brands_(candidates) {
  // Only already-qualified merchants are considered. Rank unique brands,
  // not outlet IDs, so one multi-outlet brand cannot occupy every P0 slot.
  var bestByBrand={};(candidates||[]).forEach(function(c){var key=weeklyPlanBrandKey_(c.restaurant)||String(c.resId);bestByBrand[key]=Math.max(bestByBrand[key]||0,Number(c.score)||0);});
  var ranked=Object.keys(bestByBrand).sort(function(a,b){return bestByBrand[b]-bestByBrand[a]||a.localeCompare(b);});
  // P0 is scarce even in a 200-brand portfolio: at most eight fresh P0
  // brands, but never a single arbitrary P0 when several qualify.
  var count=Math.min(ranked.length,Math.max(2,Math.min(8,Math.ceil(ranked.length*.12)))),top={};
  ranked.slice(0,count).forEach(function(key){top[key]=true;});
  (candidates||[]).forEach(function(c){if(top[weeklyPlanBrandKey_(c.restaurant)||String(c.resId)])c.priority='P0';});
  return candidates;
}

// Cooldowns count calendar days from the last completed visit, per covered
// outlet. A corporate-office visit covers every outlet recorded on that plan.
function weeklyPlanRepeatDays_(priority) {
  var keys={P0:'repeat_p0_days',P1:'repeat_p1_days',P2:'repeat_p2_days'};
  return Number(beatLogicValue_(keys[priority]||'repeat_p1_days'))||21;
}
function weeklyPlanRepeatDay_(date,days) {
  var d=new Date(String(date).slice(0,10)+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10);
}
function weeklyPlanRepeatHistory_(rows,email) {
  return (rows||[]).filter(function(r){return String(r[3]||'').toLowerCase()===String(email).toLowerCase();}).map(function(r){
    var p=weeklyPlanObject_(r), status=String(p.status).toLowerCase();
    var done=['met','closed'].indexOf(status)>=0 && !/no.show|reschedule/i.test(p.meetingOutcome||'');
    var covered=p.visitLocationType==='Corporate Office'?p.brandResIds:(p.selectedResIds.length?p.selectedResIds:[p.resId]);
    var completed=weeklyPlanDate_(r[35]||r[17]||r[2]);
    // Automatic plans previously assigned a speculative +2 day follow-up.
    // Only a saved meeting/commitment or explicit manual follow-up overrides.
    var explicitFollowup=p.source!=='Automatic'||!!(r[35]||r[39]||r[40]||r[21]);
    var due=p.commitmentDueDate||(explicitFollowup?p.followUpDate:'');
    var snapshots={};try{snapshots=JSON.parse(r[48]||'{}');}catch(ignoreSnapshot){}
    return {plan:p,done:done,covered:covered,date:completed,due:status==='closed'?'':due,snapshots:snapshots};
  });
}
function weeklyPlanWeightedMetricScore_(gaps) {
  var weights={ads:Number(beatLogicValue_('weight_ads'))/100,promos:Number(beatLogicValue_('weight_promos'))/100,funnel:Number(beatLogicValue_('weight_funnel'))/100,hygiene:Number(beatLogicValue_('weight_hygiene'))/100,segmentation:Number(beatLogicValue_('weight_segmentation'))/100};
  return Object.keys(weights).reduce(function(total,key){var value=gaps[key];return total+(typeof value==='number'&&isFinite(value)?Math.max(0,Math.min(100,value))*weights[key]:0);},0);
}
function weeklyPlanRepeatEligibility_(c,history,date) {
  var related=history.filter(function(h){return h.covered.indexOf(String(c.resId))>=0;});
  // A pending meeting anywhere in the tracker is carried/rescheduled in place.
  if (history.some(function(h){return !h.done && (h.plan.brandResIds.indexOf(String(c.resId))>=0 || weeklyPlanBrandKey_(h.plan.restaurant)===weeklyPlanBrandKey_(c.restaurant));})) return {ok:false,reason:'Existing unfinished meeting'};
  related=related.filter(function(h){return h.done;}).sort(function(a,b){return b.date.localeCompare(a.date)||b.plan.updatedAt.localeCompare(a.plan.updatedAt);});
  var last=related[0];
  if(!last) return {ok:true,reason:'Outlet not previously visited'};
  if(last.due && last.due<=date && last.due>last.date) return {ok:true,reason:'Merchant follow-up / commitment due',due:last.due};
  var change=weeklyPlanMetricRevisit_(last.snapshots && last.snapshots[String(c.resId)],c.metricSnapshot);
  if(date>last.date && change.urgent) return {ok:true,reason:'Metric deterioration: '+change.reasons.join('; ')};
  // Compare against the saved commercial score, never invented metric values.
  var oldScore=Number(last.plan.priorityScore)||0, score=Number(c.score)||0;
  var deteriorated=oldScore>0 && score-oldScore>=25 && score>=oldScore*1.35;
  if(date>last.date && deteriorated && !change.comparable) return {ok:true,reason:'Priority score worsened by at least 35% and 25 points; comparable metric snapshot unavailable'};
  if(last.due && last.due>date && last.due>last.date) return {ok:false,reason:'Agreed action is in progress; review on '+last.due,nextEligible:last.due};
  var next=weeklyPlanRepeatDay_(last.date,weeklyPlanRepeatDays_(c.priority));
  if(change.comparable && !change.urgent && !change.persistent) return {ok:false,reason:'Metrics recovered or improved; rotate to another eligible brand'};
  return {ok:date>=next,reason:'Repeat after '+weeklyPlanRepeatDays_(c.priority)+' days; last visit '+last.date,nextEligible:next};
}

// Only compare matching feed bases and a new data period. Missing values stay null.
function weeklyPlanSnapshot_(row,basis) {
  function pct(keys){var v=weeklyPlanDeepPick_(row,keys);return v===''||v==null?null:weeklyPlanPercent_(v);}
  function num(keys){var v=weeklyPlanDeepPick_(row,keys);return v===''||v==null?null:weeklyPlanNumber_(v);}
  var expected=num(['expected','expected_visibility']), actual=num(['actual','actual_visibility']);
  return {basis:basis||'',period:String(weeklyPlanPick_(row,['time_period','time period'])||''),values:{
    visibility:expected>0&&actual!==null?actual/expected*100:null,rating:num(['rating','restaurant_rating']),
    ads:pct(['ads_cv','ads/cv','current_ads_cv','ad_rev_cv']),mvd:pct(['mvd_sv','mvd/sv','mvd_sv_pc','actual_mvd_sv']),
    salt:pct(['salt_sv','salt/sv','salt_sv_pc']),zvd:pct(['zvd_sv','zvd/sv','zvd_sv_pc']),
    menu:pct(['menu_score','menu score']),i2m:pct(['i2m','impression_to_menu']),m2c:pct(['m2c','menu_to_cart']),c2o:pct(['c2o','cart_to_order'])}};
}
function weeklyPlanMetricRevisit_(before,after) {
  var result={comparable:false,urgent:false,persistent:false,reasons:[]};
  if(!before||!after||!before.basis||before.basis!==after.basis||!before.period||!after.period||before.period===after.period)return result;
  var oldPeriod=String(before.period).match(/^(\d{4})-(\d{1,2})$/),newPeriod=String(after.period).match(/^(\d{4})-(\d{1,2})$/);
  if(!oldPeriod||!newPeriod||(+newPeriod[1]*100+ +newPeriod[2])<=(+oldPeriod[1]*100+ +oldPeriod[2]))return result;
  var rules=[['visibility',Number(beatLogicValue_('visibility_target'))||95,5],['rating',Number(beatLogicValue_('rating_target'))||4,0.3],['menu',Number(beatLogicValue_('menu_score_target'))||80,10],['i2m',15,3],['m2c',20,3],['c2o',15,3],['ads',null,1],['mvd',null,1],['salt',null,1],['zvd',null,1]];
  var available=0,paired=0;
  rules.forEach(function(rule){var key=rule[0],a=before.values&&before.values[key],b=after.values&&after.values[key];if(typeof a==='number'&&isFinite(a))available++;if(typeof a!=='number'||typeof b!=='number'||!isFinite(a)||!isFinite(b))return;
    paired++;var high=key==='zvd',worsening=high?b-a:a-b;
    var threshold=Math.max(rule[2],rule[1]===null?Math.abs(a)*0.20:0);
    if(worsening>=threshold){result.urgent=true;result.reasons.push(key+' '+a.toFixed(1)+' → '+b.toFixed(1));}
    if(rule[1]!==null && b<rule[1] && worsening>=-rule[2]/2)result.persistent=true;
    if(rule[1]===null && worsening>=threshold/2)result.persistent=true;
  });result.comparable=paired>=3&&paired===available;return result;
}

function weeklyPlanCaptureCompletionMetrics_(sheet,rowNo,current,user,clusterOverride) {
  try {
    var feed=weeklyPlanSourceRows_(user.email,clusterOverride),p=weeklyPlanObject_(current),ids=p.visitLocationType==='Corporate Office'?p.brandResIds:(p.selectedResIds.length?p.selectedResIds:[p.resId]),snapshots={},latest={};
    feed.rows.forEach(function(row){var id=normId_(weeklyPlanPick_(row,['res_id','res id','restaurant_id','restaurant id']));if(ids.indexOf(String(id))<0)return;var old=latest[id];if(!old||weeklyPlanWeekSerial_(weeklyPlanPick_(row,['time_period','time period']))>=weeklyPlanWeekSerial_(weeklyPlanPick_(old,['time_period','time period'])))latest[id]=row;});
    Object.keys(latest).forEach(function(id){snapshots[id]=weeklyPlanSnapshot_(latest[id],feed.label);});
    sheet.getRange(rowNo,49).setValue(JSON.stringify(snapshots));sheet.getRange(rowNo,50).setValue(Object.keys(snapshots).length?'Captured at meeting completion':'No matching metric rows available');
  } catch(e){sheet.getRange(rowNo,50).setValue('Capture unavailable; revisit uses existing history');}
}
// Capacity units are a workload heuristic, not promised travel/meeting hours.
function weeklyPlanDailyCapacity_(){return Number(beatLogicValue_('daily_capacity_units'))||28;}
function weeklyPlanMaxOnsite_(){return Number(beatLogicValue_('max_onsite_per_day'))||5;}
function weeklyPlanVisitUnits_(type) { var mode=String(type||'').toLowerCase();return mode==='call'?(Number(beatLogicValue_('call_unit_cost'))||1):mode==='virtual'?(Number(beatLogicValue_('virtual_unit_cost'))||2):(Number(beatLogicValue_('onsite_unit_cost'))||4); }
function weeklyPlanRowMode_(r){return weeklyPlanMeetingType_(r[42])||weeklyPlanMeetingType_(r[57])||'Physical';}
function weeklyPlanRowUnits_(r){return weeklyPlanVisitUnits_(weeklyPlanRowMode_(r));}
function weeklyPlanDayLoad_(rows,email,date,excludeId) {
  return (rows||[]).reduce(function(total,r){
    if(String(r[3]||'').toLowerCase()!==String(email).toLowerCase()||weeklyPlanDate_(r[2])!==date||String(r[0])===String(excludeId||'')||/cancelled|canceled/i.test(String(r[15])))return total;
    return total+weeklyPlanRowUnits_(r);
  },0);
}
function weeklyPlanModeRecommendation_(c) {
  var values=c.metricSnapshot&&c.metricSnapshot.values||{}, operational=[];
  if(typeof values.visibility==='number'&&values.visibility<85)operational.push('availability below 85%');
  if(typeof values.menu==='number'&&values.menu<60)operational.push('menu execution below 60');
  if(typeof values.rating==='number'&&values.rating<3.5)operational.push('rating below 3.5');
  if(c.failedCall)operational.push('previous call unresolved');
  if(operational.length)return {type:'Physical',text:'On-site recommended ('+(c.priority||'P1')+'): '+operational.join(', ')+'. Inspect execution with the merchant and agree an owner and follow-up date.'};
  if(!Object.keys(values).length)return {type:'Call',text:'Remote follow-up: validate the available evidence and close a measurable commitment.'};
  return {type:'Call',text:'Remote follow-up: review the evidenced business gap and close a measurable commitment.'};
}
function weeklyPlanDistanceKm_(a,b){
  if(!a||!b||a.latitude==null||a.longitude==null||b.latitude==null||b.longitude==null)return null;
  var lat1=Number(a.latitude),lng1=Number(a.longitude),lat2=Number(b.latitude),lng2=Number(b.longitude);
  if(!isFinite(lat1)||!isFinite(lng1)||!isFinite(lat2)||!isFinite(lng2)||Math.abs(lat1)>90||Math.abs(lat2)>90||Math.abs(lng1)>180||Math.abs(lng2)>180)return null;
  var r=Math.PI/180,dLat=(lat2-lat1)*r,dLng=(lng2-lng1)*r,h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
function weeklyPlanBusinessValue_(c){
  // Geography must never create a candidate: these are already metric-qualified
  // brands. This value only ranks their commercial urgency inside a feasible
  // on-site pocket. A saved due commitment and P0 outweigh travel convenience.
  return Number(c.score||0)+(c.priority==='P0'?120:c.priority==='P1'?35:0)+(c.repeatDue?80:0)+(weeklyPlanModeRecommendation_(c).type==='Physical'?15:0);
}
function weeklyPlanNearbySites_(route,start,limit){
  var mapped=route.filter(function(c){return weeklyPlanDistanceKm_(c,c)!==null;});if(!mapped.length)return [];
  // First rank already-qualified brands by priority, metric score and due
  // commitments. Then use coordinates only to find a feasible compact pocket.
  var best=null,bestScore=-Infinity;
  var pocketRadius=Number(beatLogicValue_('route_cluster_radius_km'))||4,maxLeg=Number(beatLogicValue_('route_max_leg_km'))||6;
  mapped.forEach(function(anchor){var city=weeklyPlanBrandKey_(anchor.city),neighbors=mapped.filter(function(c){var km=weeklyPlanDistanceKm_(anchor,c);return km!==null&&km<=pocketRadius&&(!city||weeklyPlanBrandKey_(c.city)===city);}).sort(function(a,b){return weeklyPlanBusinessValue_(b)-weeklyPlanBusinessValue_(a);});
    var fromStart=weeklyPlanDistanceKm_(start,anchor),score=neighbors.slice(0,limit).reduce(function(sum,c){return sum+weeklyPlanBusinessValue_(c);},0)-Math.min(20,(fromStart||0)*.15);
    if(score>bestScore){bestScore=score;best={anchor:anchor,neighbors:neighbors};}
  });
  var chosen=[],remaining=best.neighbors.slice(0,limit),current=start&&weeklyPlanDistanceKm_(start,start)!==null?start:best.anchor;
  while(remaining.length&&chosen.length<limit){var reachable=chosen.length?remaining.filter(function(c){return weeklyPlanDistanceKm_(current,c)<=maxLeg;}):remaining;if(!reachable.length)break;reachable.sort(function(a,b){var da=weeklyPlanDistanceKm_(current,a),db=weeklyPlanDistanceKm_(current,b);return (da===null?999:da)-(db===null?999:db)||weeklyPlanBusinessValue_(b)-weeklyPlanBusinessValue_(a);});var next=reachable[0];remaining.splice(remaining.indexOf(next),1);chosen.push(next);current=next;}
  return chosen;
}
function weeklyPlanRepeatAssignments_(candidates,rows,email,monday,slots,start,today,time,workingDates,leaveDates) {
  var history=weeklyPlanRepeatHistory_(rows,email), pool=(candidates||[]).slice(), ids={};
  pool.forEach(function(c){ids[String(c.resId)]=true;});
  // Due commitments remain eligible even if the outlet's performance has
  // recovered enough to disappear from the normal priority candidate feed.
  history.slice().sort(function(a,b){return b.date.localeCompare(a.date);}).forEach(function(h){
    if(!h.done||!h.due) return;
    h.covered.forEach(function(id){
      if(ids[id]) return;
      ids[id]=true;
      var p=h.plan;
      pool.push({resId:id,restaurant:p.restaurant,city:p.city,cluster:p.cluster,priority:p.priority,score:p.priorityScore,latitude:p.latitude,longitude:p.longitude,objective:p.merchantCommitment?'Review the agreed merchant commitment: '+p.merchantCommitment:p.objective,talkingPoints:p.talkingPoints,nextAction:'Record the commitment outcome and next agreed follow-up date.',rationale:'Saved merchant follow-up'});
    });
  });
  var assigned={}, out=[], current=start;
  out.dayAudit=[];
  // Bounded six-week horizon: overflow stays visible in the relevant week.
  for(var offset=0;offset<(workingDates?workingDates.length:42);offset++) {
    var date=workingDates?workingDates[offset]:weeklyPlanRepeatDay_(monday,offset);
    var dow=new Date(date+'T12:00:00Z').getUTCDay();
    if(date<today){out.dayAudit.push({date:date,planned:0,reason:'Past date — no new meetings added.'});continue;}
    if((leaveDates||[]).indexOf(date)>=0){out.dayAudit.push({date:date,planned:0,reason:'Leave day — visits move to another working day.'});continue;}
    if(dow===0||dow===6){out.dayAudit.push({date:date,planned:0,reason:dow===6?'Saturday lead-list sprint.':'Sunday rest day.'});continue;}
    var eligible=pool.filter(function(c){return !assigned[weeklyPlanBrandKey_(c.restaurant)] && weeklyPlanRepeatEligibility_(c,history,date).ok;});
    var groups=weeklyPlanGroupBrandCandidates_(eligible);
    groups.forEach(function(g){
      var decisions=eligible.filter(function(c){return weeklyPlanBrandKey_(c.restaurant)===weeklyPlanBrandKey_(g.restaurant);}).map(function(c){return weeklyPlanRepeatEligibility_(c,history,date);});
      var due=decisions.filter(function(d){return d.due;}).sort(function(a,b){return a.due.localeCompare(b.due);})[0];
      g.repeatReason=due?due.reason:weeklyPlanRepeatEligibility_(g,history,date).reason;
      g.repeatDue=due?due.due:'';
    });
    var route=groups.sort(function(a,b){return (a.repeatDue&&!b.repeatDue?-1:!a.repeatDue&&b.repeatDue?1:0)||String(a.repeatDue||'').localeCompare(String(b.repeatDue||''))||({P0:0,P1:1,P2:2}[a.priority]||0)-({P0:0,P1:1,P2:2}[b.priority]||0)||(Number(b.score)||0)-(Number(a.score)||0)||String(a.restaurant).localeCompare(String(b.restaurant));});
    var capacity=weeklyPlanDailyCapacity_(),maxOnsite=weeklyPlanMaxOnsite_(),load=weeklyPlanDayLoad_(rows,email,date),availableUnits=Math.max(0,capacity-load),plannedBefore=out.length;
    var existing=(rows||[]).filter(function(r){return String(r[3]||'').toLowerCase()===String(email).toLowerCase()&&weeklyPlanDate_(r[2])===date&&!/cancelled|canceled/i.test(String(r[15]));});
    var onsite=existing.filter(function(r){return weeklyPlanRowMode_(r)==='Physical';}).length,calls=existing.filter(function(r){return weeklyPlanRowMode_(r)!=='Physical';}).length;
    function assign_(c,mode){var key=weeklyPlanBrandKey_(c.restaurant),units=weeklyPlanVisitUnits_(mode);
      if(assigned[key]||load+units>capacity||mode==='Physical'&&onsite>=maxOnsite)return false;
      load+=units;if(mode==='Physical')onsite++;else calls++;assigned[key]=true;
      var suggested=weeklyPlanModeRecommendation_(c);
      out.push({candidate:c,date:date,time:'',plannedMode:mode,meetingType:'',recommendation:suggested.text,units:units,reason:c.repeatReason});return true;
    }
    // Up to five genuinely nearby visits can coexist with as many calls as
    // fit in the remaining 28-unit day. Calls are one unit each.
    // A sparse pocket naturally yields fewer visits; never add a far stop just
    // to satisfy a daily count.
    var siteLimit=Math.min(maxOnsite-onsite,route.length),sites=weeklyPlanNearbySites_(route,start,Math.max(0,siteLimit));
    sites.forEach(function(c){assign_(c,'Physical');});
    // The call queue keeps the same business ranking. A high-impact merchant
    // outside today's on-site pocket still gets a call, not silently dropped
    // behind lower-score brands whose recommendation happened to say "Call".
    route.forEach(function(c){if(!assigned[weeklyPlanBrandKey_(c.restaurant)])assign_(c,'Call');});
    var plannedToday=out.length-plannedBefore;
    out.dayAudit.push({date:date,planned:plannedToday,onsite:onsite,calls:calls,eligibleBrands:groups.length,existingLoad:capacity-availableUnits,
      reason:plannedToday?'':(pool.length?'No new brand due today: repeat cooldown/open meetings or this day’s capacity.':'No metric-qualified brands in the loaded portfolio.')});
  }
  return out;
}

function weeklyPlanBrandKey_(value) {
  return String(value || '').toLowerCase().replace(/\s+/g,' ').trim().replace(/[^a-z0-9 ]/g,'');
}

// A single merchant brand can own multiple restaurant IDs. Keep the most
// material outlet's commercial brief as the visit agenda, while preserving all
// mapped outlets for selection and on-site location verification.
function weeklyPlanGroupBrandCandidates_(candidates) {
  var groups = {};
  (candidates || []).forEach(function(candidate) {
    var key = weeklyPlanBrandKey_(candidate.restaurant) || ('res-'+String(candidate.resId));
    var group = groups[key];
    var outlet = {id:String(candidate.resId || ''), name:String(candidate.restaurant||''), mid:String(candidate.mid||''), chainId:String(candidate.chainId||''), latitude:weeklyPlanLatitude_(candidate.latitude), longitude:weeklyPlanLongitude_(candidate.longitude)};
    if (!group) {
      group = {};
      Object.keys(candidate).forEach(function(k){ group[k]=candidate[k]; });
      group.resIds=[]; group.outlets=[];
      groups[key]=group;
    }
    if (outlet.id && group.resIds.indexOf(outlet.id) < 0) { group.resIds.push(outlet.id); group.outlets.push(outlet); }
    // The highest-priority/highest-impact restaurant gives the brand visit
    // its agenda and route anchor without losing the other outlet IDs.
    if (weeklyPlanNumber_(candidate.score) > weeklyPlanNumber_(group.score)) {
      var ids=group.resIds, outlets=group.outlets;
      Object.keys(candidate).forEach(function(k){ group[k]=candidate[k]; });
      group.resIds=ids; group.outlets=outlets;
    }
  });
  return Object.keys(groups).map(function(key){ return groups[key]; }).sort(function(a,b){
    var p={P0:0,P1:1,P2:2};
    return p[a.priority]-p[b.priority] || weeklyPlanNumber_(b.score)-weeklyPlanNumber_(a.score) || String(a.restaurant).localeCompare(String(b.restaurant));
  });
}

// Keep every populated input measure available to the model. This lets the AI
// discuss Ads, hygiene, promo discounts, funnel and customer segmentation when
// they exist in the CSV, rather than treating NOV/visibility/rating as the
// only conversation inputs. Empty cells and oversized values are excluded.
function weeklyPlanMerchantInternalMetricKey_(key) {
  var k=weeklyPlanKey_(key);
  return k === 'nov' || k.indexOf('nov_') === 0 || k.indexOf('_nov') >= 0 ||
    k.indexOf('target_nov') >= 0 || k.indexOf('actual_nov') >= 0 ||
    k.indexOf('cm_target') >= 0 || k.indexOf('target_cm') >= 0 ||
    k.indexOf('cm_actual') >= 0 || k.indexOf('actual_cm') >= 0;
}
function weeklyPlanAiMetricPack_(currentRow, novRow, amtlRow) {
  function pack_(row) {
    var out={}, count=0;
    function append_(key,value,depth) {
      if (count>=180 || value==='' || value==null || depth>4) return;
      if (weeklyPlanMerchantInternalMetricKey_(key)) return;
      if (typeof value === 'string') {
        var text=value.trim();
        if (!text) return;
        if (/^[\[{]/.test(text)) {
          try { append_(key,JSON.parse(text),depth+1); return; } catch(ignore) {}
        }
        if (text.length<=1200) { out[String(key)]=text; count++; }
        return;
      }
      if (typeof value === 'object') {
        Object.keys(value).forEach(function(child){ append_(key+'.'+child,value[child],depth+1); });
        return;
      }
      out[String(key)]=value; count++;
    }
    Object.keys(row || {}).forEach(function(key) { if (key !== '__period') append_(key,row[key],0); });
    return out;
  }
  var canonical={};
  [
    ['orders',['orders','total_orders','order_makes']],['sv_pc',['sv_pc','sv+pc','sv','supply_value']],['cv',['cv','customer_value']],['nov_po',['nov_po','nov/po']],['asv',['asv']],['acv',['acv']],
    ['rating',['rating','restaurant_rating']],['thumbnail',['thumbnail','thumbnail_flag','has_thumbnail']],['menu_score',['menu_score','menu score']],['images',['items_with_image','items_with_images']],['descriptions',['items_with_description','items_with_descriptions']],['visibility',['visibility','visibility_pct']],
    ['impressions',['impressions']],['menu_opens',['menu_opens','mos','mo']],['i2m',['i2m']],['m2c',['m2c']],['c2o',['c2o']],['m2o',['m2o']],['i2o',['i2o']],
    ['ads_ov_pct',['ads_ov_pct','ads ov%']],['ads_roi',['ads_roi','ad_roi']],['ads_cv',['ads_cv','ads/cv']],['ads_sv',['ads_sv','ads_sv_pc','ads/sv+pc','ads/sv']],['ads_cpc',['cpc','ads_cpc']],['ads_delivery',['delivery_pct','ads_delivery_pct']],['monthly_booked_ads',['monthly_booked_ads','booked_ads']],['billed_ads',['billed_ads']],['bau_ads_cv',['bau_ads_cv','bau ads/cv']],['gm_ads_cv',['gm_ads_cv','gm ads/cv']],['ads_res_coverage',['ads_res_coverage']],['ads_cv_coverage',['ads_cv_coverage']],
    ['coded_ov_pct',['coded_ov_pct','coded ov%']],['salt_ov_pct',['salt_ov_pct','salt ov%']],['discount_ov_pct',['discount_ov_pct','discount ov%']],['mvd_sv',['mvd_sv','mvd_sv_pc','mvd/sv+pc']],['zvd_sv',['zvd_sv','zvd_sv_pc','zvd/sv+pc']],['tvd_sv',['tvd_sv','tvd_sv_pc','tvd/sv+pc']],['merchant_share_pct',['mshare_pct','merchant_share_pct']],['zomato_share_pct',['zshare_pct','zomato_share_pct']],['salt_sv',['salt_sv','salt_sv_pc','salt/sv+pc']],
    ['new_ov',['new_orders','new']],['repeat_ov',['repeat_orders','repeat']],['lapsed_ov',['lapsed_orders','lapsed']],['pg_7_10',['pg_7_10']],['pg_4_6',['pg_4_6']],['pg_1_3',['pg_1_3']],['breakfast',['breakfast']],['lunch',['lunch']],['evening',['evening']],['dinner',['dinner']],['late_night',['late_night']],
    ['impression_rms',['impression_rms']],['ov_rms',['ov_rms']],['total_cuisine_impressions',['total_cuisine_impressions']],['total_cuisine_ov',['total_cuisine_ov']],
    ['pe_flag',['pe_flag','p.e. flag']],['ads_flag',['ads_flag']],['ar_flag',['ar_flag']],['gm1',['gm1','grow_max_1','grow maxxx 1']],['gm2',['gm2','grow_max_2','grow maxxx 2']],['gm3',['gm3','grow_max_3','grow maxxx 3']],['sgm',['sgm']],['mvd_flag',['mvd_flag']],['salt_flag',['salt_flag']],['veg_type',['veg_type']],['cart_breaker',['cart_breaker']]
  ].forEach(function(spec){var value=weeklyPlanDeepPick_(currentRow,spec[1]);if(value!==''&&value!=null)canonical[spec[0]]=value;});
  return {canonical:canonical,current_period:pack_(currentRow),restaurant_mapping:pack_(amtlRow)};
}

// Compact, human-readable metric cards for the field brief.  We show a card
// only when the feed carries the relevant metric/benchmark, and make the
// condition explicit so the KAM knows exactly why it is being discussed.
function weeklyPlanBriefCards_(m) {
  m=m || {}; var out=[];
  function has_(v){ return v !== '' && v !== null && v !== undefined && isFinite(Number(v)); }
  function pct_(v){ return weeklyPlanFmtPct_(Number(v)); }
  function trend_(cm,lm,l2m,label){var values=[];if(has_(cm))values.push('CM '+label+' '+pct_(cm));if(has_(lm)&&Number(lm)>0)values.push('LM '+pct_(lm));if(has_(l2m)&&Number(l2m)>0)values.push('L2M '+pct_(l2m));return values;}
  function bench_(key){var b=(m.benchmarks||{})[key]||{},values=[];if(has_(b.avg)&&Number(b.avg)>0)values.push('Cuisine × City avg '+pct_(b.avg));if(has_(b.max)&&Number(b.max)>0)values.push('Cuisine × City max '+pct_(b.max));return values;}
  function card_(category, metric, condition, values, tone, rank){
    out.push({category:category,metric:metric,condition:condition,values:values.filter(Boolean),tone:tone || 'watch',rank:rank || 0});
  }
  if (has_(m.adsCv) || m.adsRoi>0 || has_(m.adsOrderShare) || m.lmAdsCv>0 || m.gmaxxModel) card_('Ads','Ads performance',m.targetAdsCv>0 && m.adsCv<m.targetAdsCv?'Ads/CV is below approved target':'Validate investment, return, order contribution and Gmaxx model',trend_(m.adsCv,m.lmAdsCv,m.l2mAdsCv,'Ads/CV').concat(bench_('adsCv')).concat([m.adsRoi>0?'Ads ROI '+Number(m.adsRoi).toFixed(2):'',has_(m.adsOrderShare)?'Ad order % '+pct_(m.adsOrderShare):'',m.gmaxxModel?'Gmaxx model '+String(m.gmaxxModel):'']),m.targetAdsCv>0 && m.adsCv<m.targetAdsCv?'critical':'watch',3);
  if (has_(m.mvdSv) || m.intendedMvdSv>0 || m.lmMvdSv>0 || has_(m.promoPenetration) && m.promoPenetration>0) card_('Promos','MVD & promo adoption',m.intendedMvdSv>0 && m.mvdSv<m.intendedMvdSv?'Actual MVD/SV is below intended':'Validate promo penetration and merchant co-funding',trend_(m.mvdSv,m.lmMvdSv,m.l2mMvdSv,'MVD/SV').concat([m.intendedMvdSv>0?'Intended MVD/SV '+pct_(m.intendedMvdSv):'']).concat(bench_('mvdSv')).concat([m.promoPenetration>0?'Promo order % '+pct_(m.promoPenetration):'']),m.intendedMvdSv>0 && m.mvdSv<m.intendedMvdSv?'critical':'good',4);
  if (has_(m.actualMshare) || m.intendedMshare>0 || m.lmMshare>0 || m.l2mMshare>0) card_('Promos','Merchant share',m.intendedMshare>0 && m.actualMshare<m.intendedMshare?'Actual merchant share is below intended':'Validate the merchant co-funding share',trend_(m.actualMshare,m.lmMshare,m.l2mMshare,'merchant share').concat([m.intendedMshare>0?'Intended merchant share '+pct_(m.intendedMshare):'']).concat(bench_('mshare')),m.intendedMshare>0 && m.actualMshare<m.intendedMshare?'critical':'good',4.5);
  if (m.lmSaltSv>0 || m.l2mSaltSv>0 || m.saltSv>0) card_('Promos','Salt/SV',m.lmSaltSv>0 && m.saltSv<m.lmSaltSv?'Salt/SV is below recent level':'Salt/SV is stable versus recent level',trend_(m.saltSv,m.lmSaltSv,m.l2mSaltSv,'Salt/SV').concat(bench_('saltSv')),m.lmSaltSv>0 && m.saltSv<m.lmSaltSv?'watch':'good',5);
  if (m.mvdSaltSv>0 || has_(m.promoPenetration)) card_('Promos','Combined promo depth','Review merchant-funded depth and promo order contribution together',[m.mvdSaltSv>0?'MVD + Salt/SV '+pct_(m.mvdSaltSv):'',has_(m.promoPenetration)?'Promo order % '+pct_(m.promoPenetration):''],'watch',5.2);
  if (m.lmZvdSv>0 || m.l2mZvdSv>0 || m.zvdSv>0) card_('Discounts','ZVD/SV',m.lmZvdSv>0 && m.zvdSv>m.lmZvdSv?'ZVD/SV has increased — reduce subsidy load':'Track ZVD/SV; lower is better',trend_(m.zvdSv,m.lmZvdSv,m.l2mZvdSv,'ZVD/SV'),m.lmZvdSv>0 && m.zvdSv>m.lmZvdSv?'critical':'watch',6);
  // Keep the promo/discount conversation identical to Portfolio deep dive:
  // Coded OV and Salt OV are order shares, while the discount amounts show
  // the actual merchant/Zomato investment behind those shares.
  if (m.codedOv>0 || m.saltOv>0 || m.discountOv>0) card_('Discounts','OV contribution', 'Validate the promo mix and resulting order contribution',[m.codedOv>0?'Coded OV '+pct_(m.codedOv):'',m.saltOv>0?'Salt OV '+pct_(m.saltOv):'',m.discountOv>0?'Discount OV '+pct_(m.discountOv):''],'watch',7);
  if (m.promoDiscount>0 || m.saltDiscount>0 || m.zvdDiscount>0 || m.totalDiscount>0) card_('Discounts','Total discount mix','Review where the discount investment is coming from before changing the merchant offer',[m.promoDiscount>0?'MVD discount '+weeklyPlanFmtNum_(m.promoDiscount):'',m.saltDiscount>0?'Salt discount '+weeklyPlanFmtNum_(m.saltDiscount):'',m.zvdDiscount>0?'ZVD '+weeklyPlanFmtNum_(m.zvdDiscount):'',m.totalDiscount>0?'Total discount '+weeklyPlanFmtNum_(m.totalDiscount):''],m.zvdDiscount>m.promoDiscount && m.zvdDiscount>0?'watch':'good',7.1);
  if (m.visibility>0 || m.rating>0 || m.menu>0 || m.rejectionRate>0 || m.kptDelayRate>0 || m.refundRate>0 || m.menuContentHealth>0 || m.serviceability>0) card_('Customer Experience','Hygiene & operations',m.visibility!==null && m.visibility<95?'Availability/listing hygiene needs recovery':'Review operational quality and customer experience',[m.visibility>0?'Visibility '+pct_(m.visibility):'',m.rating>0?'Rating '+Number(m.rating).toFixed(1):'',m.menu>0?'Menu score '+pct_(m.menu):'',m.rejectionRate>0?'Rejection rate '+pct_(m.rejectionRate):'',m.kptDelayRate>0?'KPT delayed '+pct_(m.kptDelayRate):'',m.refundRate>0?'MX refund/GMV '+pct_(m.refundRate):'',m.menuContentHealth>0?'Content health '+pct_(m.menuContentHealth):'',m.serviceability>0?'Serviceability '+pct_(m.serviceability):''],m.visibility!==null && m.visibility<95 || (m.rating>0 && m.rating<4) || (m.menu>0 && m.menu<80)?'critical':'good',8);
  if (m.m2o>0 || m.m2c>0 || m.c2o>0 || m.i2m>0) card_('Funnel','I2M · M2C · C2O · M2O','Identify the lowest conversion step and compare it with Cuisine × City',[m.i2m>0?'I2M '+pct_(m.i2m):''].concat(bench_('i2m')).concat([m.m2c>0?'M2C '+pct_(m.m2c):'']).concat(bench_('m2c')).concat([m.c2o>0?'C2O '+pct_(m.c2o):'']).concat(bench_('c2o')).concat([m.m2o>0?'M2O '+pct_(m.m2o):'']).concat(bench_('m2o')),'watch',9);
  if (m.newMix>0 || m.repeatMix>0 || m.lapsedMix>0) card_('Customer segmentation','New · Repeat · Lapsed','Use customer mix to decide acquisition, repeat or reactivation action',[m.newMix>0?'New '+pct_(m.newMix):'',m.repeatMix>0?'Repeat '+pct_(m.repeatMix):'',m.lapsedMix>0?'Lapsed '+pct_(m.lapsedMix):''],'watch',10);
  if (m.pg710Mix>0 || m.pg46Mix>0 || m.pg13Mix>0) card_('Customer segmentation','PG mix','Use the strongest customer cohort to tailor creative, offer and menu conversations',[m.pg710Mix>0?'PG 7–10 '+pct_(m.pg710Mix):'',m.pg46Mix>0?'PG 4–6 '+pct_(m.pg46Mix):'',m.pg13Mix>0?'PG 1–3 '+pct_(m.pg13Mix):''],'watch',10.1);
  if (m.breakfastMix>0 || m.lunchMix>0 || m.eveningMix>0 || m.dinnerMix>0 || m.lateNightMix>0) card_('Customer segmentation','Mealtime mix','Plan menu, availability and promotion around the restaurant’s highest-demand occasions',[m.breakfastMix>0?'Breakfast '+pct_(m.breakfastMix):'',m.lunchMix>0?'Lunch '+pct_(m.lunchMix):'',m.eveningMix>0?'Evening '+pct_(m.eveningMix):'',m.dinnerMix>0?'Dinner '+pct_(m.dinnerMix):'',m.lateNightMix>0?'Late night '+pct_(m.lateNightMix):''],'watch',10.2);
  var flags=m.operatingFlags||{},flagValues=[];
  [['P.E.',flags.pe],['Ads',flags.ads],['AR',flags.ar],['GM1',flags.gm1],['GM2',flags.gm2],['GM3',flags.gm3],['SGM',flags.sgm],['MVD',flags.mvd],['Salt',flags.salt],['Food mix',flags.vegType],['Cart-breaker',flags.cartBreaker]].forEach(function(x){if(String(x[1]||'').trim())flagValues.push(x[0]+' '+String(x[1]));});
  if(flagValues.length)card_('Operating flags','Program & restaurant flags','Use active flags to validate the exact program, offer and assortment conversation',flagValues,'watch',10.5);
  if (m.priceFlag && ['0','no','false'].indexOf(String(m.priceFlag).toLowerCase())<0) card_('Pricing','Price disparity','Menu-price disparity is flagged — validate alignment and owner',['Flag '+String(m.priceFlag)],'critical',11);
  return out.sort(function(a,b){return a.rank-b.rank;});
}

function weeklyPlanAiMetricsForPlan_(plan, user, clusterOverride) {
  if (!plan || !plan.resId) return {};
  var source=weeklyPlanSourceRows_(user.email, clusterOverride);
  var hit=(weeklyPlanCandidates_(source.rows, user.email, clusterOverride, user.cluster, source.novRows || []) || []).filter(function(candidate){
    return String(candidate.resId) === String(plan.resId);
  })[0];
  var pack=hit && hit.aiMetrics ? hit.aiMetrics : {};
  try {
    var history=weeklyPlanHistoryForBeat_(plan.resId,user.email,clusterOverride || plan.cluster);
    pack.canonical=pack.canonical||{};pack.canonical.cuisine_city_benchmarks=history && history.peer ? (history.peer.benchmarks||{}) : {};
    pack.cm=history && history.current || {};pack.lm=history && history.metrics || {};pack.l2m=history && history.metrics2 || {};
  } catch(historyIgnore) {}
  return pack;
}

function weeklyPlanPick_(row, aliases) {
  row = row || {}; aliases = aliases || [];
  for (var a=0;a<aliases.length;a++) {
    var want = weeklyPlanKey_(aliases[a]), keys = Object.keys(row);
    for (var k=0;k<keys.length;k++) if (weeklyPlanKey_(keys[k]) === want && row[keys[k]] !== '' && row[keys[k]] != null) return row[keys[k]];
  }
  return '';
}
// Supports direct CSV columns as well as JSON objects embedded in a CSV cell.
// This is deliberately bounded so large payloads cannot slow weekly planning.
function weeklyPlanDeepPick_(row, aliases) {
  aliases=aliases || [];
  var direct=weeklyPlanPick_(row,aliases);
  if (direct !== '' && !(typeof direct === 'string' && /^[\[{]/.test(direct.trim()))) return direct;
  var wanted={};
  aliases.forEach(function(alias){ wanted[weeklyPlanKey_(alias)]=true; });
  function scan_(value, depth) {
    if (value == null || depth > 4) return '';
    if (typeof value === 'string') {
      var text=value.trim();
      if (!/^[\[{]/.test(text)) return '';
      try { return scan_(JSON.parse(text),depth+1); } catch(ignore) { return ''; }
    }
    if (typeof value !== 'object') return '';
    var keys=Object.keys(value), i, key, child;
    for (i=0;i<keys.length;i++) {
      key=keys[i]; child=value[key];
      if (wanted[weeklyPlanKey_(key)] && child !== '' && child != null && typeof child !== 'object') return child;
    }
    for (i=0;i<keys.length;i++) {
      child=scan_(value[keys[i]],depth+1);
      if (child !== '') return child;
    }
    return '';
  }
  return scan_(row,0);
}
function weeklyPlanKey_(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }
function weeklyPlanNumber_(value) { var n=parseFloat(String(value == null ? '' : value).replace(/[,₹%\s]/g,'')); return isFinite(n) ? n : 0; }
function weeklyPlanCoordinate_(value) { var n=parseFloat(String(value == null ? '' : value).replace(/[^0-9.\-]/g,'')); return isFinite(n) ? n : null; }
function weeklyPlanLatitude_(value) { var n=weeklyPlanCoordinate_(value); return n !== null && Math.abs(n) <= 90 ? n : null; }
function weeklyPlanLongitude_(value) { var n=weeklyPlanCoordinate_(value); return n !== null && Math.abs(n) <= 180 ? n : null; }
function weeklyPlanRouteStart_(value) { value=value || {}; var lat=weeklyPlanLatitude_(value.latitude), lng=weeklyPlanLongitude_(value.longitude); return lat === null || lng === null ? null : {latitude:lat,longitude:lng}; }
function weeklyPlanHaversineKm_(a,b) { var lat1=weeklyPlanLatitude_(a && a.latitude), lon1=weeklyPlanLongitude_(a && a.longitude), lat2=weeklyPlanLatitude_(b && b.latitude), lon2=weeklyPlanLongitude_(b && b.longitude); if(lat1===null||lon1===null||lat2===null||lon2===null)return 0; var rad=Math.PI/180,dLat=(lat2-lat1)*rad,dLon=(lon2-lon1)*rad,x=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)*Math.sin(dLon/2); return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); }
function weeklyPlanPercent_(value) { var n=weeklyPlanNumber_(value); return n>0 && n<=1 ? n*100 : n; }
function weeklyPlanFmtPct_(value) { return (isFinite(value) ? value : 0).toFixed(1)+'%'; }
function weeklyPlanFmtNum_(value) { return Math.round(weeklyPlanNumber_(value)).toLocaleString('en-IN'); }
function weeklyPlanWeekSerial_(value) { var m=String(value || '').match(/^(\d{4})-(\d{1,2})$/); return m ? (+m[1]*100 + +m[2]) : 0; }

function weeklyPlanDeckFolder_() {
  var props=PropertiesService.getScriptProperties(), id=props.getProperty(WEEKLY_PLAN_DECK_FOLDER_PROP_), folder=null;
  try { folder=id ? DriveApp.getFolderById(id) : null; } catch(ignore) {}
  if (!folder) { folder=DriveApp.createFolder('Brahmastra — Weekly Plan Decks'); props.setProperty(WEEKLY_PLAN_DECK_FOLDER_PROP_,folder.getId()); }
  return folder;
}
function weeklyPlanDeckBullets_(value) {
  return String(value || '').split(/\n|•/).map(function(v){return String(v).trim().replace(/^[-–]\s*/, '');}).filter(Boolean).slice(0,6);
}
function weeklyPlanDeckAccent_(index) { return ['#151821','#273E7C','#1C6B55','#9B5A18','#6B2C91'][index % 5]; }
function weeklyPlanDeckText_(value, fallback, max) {
  var text = String(value == null ? '' : value).trim() || String(fallback || '');
  max = max || 220;
  return text.length > max ? text.slice(0,max-1).trim() + '…' : text;
}
function weeklyPlanDeckList_(value, fallback) {
  var list = Array.isArray(value) ? value : weeklyPlanDeckBullets_(value);
  list = list.map(function(item){ return weeklyPlanDeckText_(item, '', 175); }).filter(Boolean).slice(0,6);
  return list.length ? list : weeklyPlanDeckBullets_(fallback || 'Confirm the next measurable action.');
}
function weeklyPlanMerchantSafeObjective_(value) {
  var text=String(value || '').trim();
  if (/(^|[^a-z])(nov|cm)([^a-z]|$)|\btarget\b|\bachievement\b|\bgap\b/i.test(text)) {
    return 'Review the customer, operational and conversion levers and agree one measurable merchant commitment.';
  }
  return text || 'Review the customer, operational and conversion levers and agree one measurable merchant commitment.';
}
function weeklyPlanMerchantSafeTalkingPoints_(value) {
  return String(value || '').split(/\r?\n/).filter(function(line) {
    return !/(^|[^a-z])(nov|cm)([^a-z]|$)|\btarget\b|\bachievement\b|\bgap\b/i.test(line);
  }).join('\n').slice(0,2000);
}
function weeklyPlanStaticDeckContent_(plan, user) {
  return {
    cover:{title:'Brahmastra · ' + (plan.restaurant || 'Merchant meeting'), subtitle:'Weekly merchant growth meeting'},
    slides:[
      {accent:'#E23744',heading:'The growth opportunity',bullets:['Review the customer, operational and conversion levers with the merchant.',weeklyPlanMerchantSafeObjective_(plan.objective)]},
      {accent:'#273E7C',heading:'What we will diagnose together',bullets:weeklyPlanDeckBullets_(weeklyPlanMerchantSafeTalkingPoints_(plan.talkingPoints) || 'Review customer experience, discovery, conversion and merchant support required.')},
      {accent:'#1C6B55',heading:'The joint action plan',bullets:weeklyPlanDeckBullets_(plan.nextAction || 'Agree owner, due date and measurable next step.').concat(['Next review: ' + (plan.followUpDate || 'To be confirmed')]).slice(0,4)}
    ]
  };
}
// A self-contained wordmark keeps every exported deck branded even when the
// recipient cannot access a Drive-hosted image asset.
function weeklyPlanDeckZomatoMark_(slide, x, y) {
  var mark=slide.insertTextBox('zomato',x,y,92,22);
  mark.getText().getTextStyle().setFontSize(18).setBold(true).setItalic(true).setForegroundColor('#E23744');
  return mark;
}
function weeklyPlanDeckCoverSlide_(slide, accent, cover, plan, imageBlob) {
  try { slide.getPageElements().forEach(function(el){ el.remove(); }); } catch(ignore) {}
  try { slide.getBackground().setSolidFill('#10131A'); } catch(ignore2) {}
  var band=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,0,0,720,16); band.getFill().setSolidFill(accent); try { band.getBorder().setTransparent(); } catch(ignore3) {}
  weeklyPlanDeckZomatoMark_(slide,594,28);
  var panel=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,38,70,imageBlob ? 365 : 644,270); panel.getFill().setSolidFill('#181D28'); try { panel.getBorder().setTransparent(); } catch(panelIgnore) {}
  var kicker=slide.insertTextBox('BRAHMASTRA  /  WEEKLY GROWTH CONVERSATION',62,96,335,18); kicker.getText().getTextStyle().setFontSize(10).setBold(true).setForegroundColor('#FDA4AF');
  var heading=weeklyPlanDeckText_(cover.title, 'Brahmastra · ' + (plan.restaurant || 'Merchant meeting'), 94);
  var title=slide.insertTextBox(heading,62,125,imageBlob ? 315 : 560,76); title.getText().getTextStyle().setFontSize(27).setBold(true).setForegroundColor('#F8FAFC');
  var subtitle=weeklyPlanDeckText_(cover.subtitle, 'Weekly merchant growth meeting', 175);
  var bodyLines=[subtitle,'Meeting focus: agree the most useful customer, operational and conversion actions for this week.',(plan.city || 'City TBC') + (plan.resId ? '  •  Res ID ' + plan.resId : '')];
  var body=slide.insertTextBox(bodyLines.join('\n\n'),62,220,imageBlob ? 315 : 545,88); body.getText().getTextStyle().setFontSize(13).setForegroundColor('#CBD5E1');
  if (imageBlob) {
    var imagePanel=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,426,70,256,270); imagePanel.getFill().setSolidFill('#252A37'); try { imagePanel.getBorder().setTransparent(); } catch(imagePanelIgnore) {}
    try { slide.insertImage(imageBlob,438,82,232,246); } catch(imageIgnore) {}
  } else {
    var mark=slide.insertShape(SlidesApp.ShapeType.ELLIPSE,554,126,126,126); mark.getFill().setSolidFill('#292F3D'); try { mark.getBorder().setTransparent(); } catch(markIgnore) {}
    var markText=slide.insertTextBox('GROW\nTOGETHER',574,165,88,44); markText.getText().getTextStyle().setFontSize(15).setBold(true).setForegroundColor('#FDE68A');
  }
  var foot=slide.insertTextBox('Brahmastra · Weekly merchant plan',38,374,620,16); foot.getText().getTextStyle().setFontSize(8).setForegroundColor('#94A3B8');
}
function weeklyPlanDeckFrame_(slide, accent, kicker, pageNo) {
  try { slide.getPageElements().forEach(function(el){ el.remove(); }); } catch(ignore) {}
  try { slide.getBackground().setSolidFill('#0D111B'); } catch(ignore2) {}
  var top=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,0,0,720,12); top.getFill().setSolidFill(accent); try {top.getBorder().setTransparent();} catch(ignore3) {}
  var halo=slide.insertShape(SlidesApp.ShapeType.ELLIPSE,582,218,190,190); halo.getFill().setSolidFill('#171E2E'); try {halo.getBorder().setTransparent();} catch(ignore4) {}
  weeklyPlanDeckZomatoMark_(slide,595,28);
  var key=slide.insertTextBox(String(kicker || 'BRAHMASTRA / MERCHANT GROWTH STUDIO').toUpperCase(),42,42,430,14);
  key.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#94A3B8');
  var page=slide.insertTextBox(('0'+(pageNo || 1)).slice(-2)+' / 07',42,378,65,12);
  page.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#64748B');
}
function weeklyPlanDeckPill_(slide, label, x, y, w, accent) {
  var pill=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,x,y,w,22); pill.getFill().setSolidFill('#1D2636'); try {pill.getBorder().setTransparent();} catch(ignore) {}
  var text=slide.insertTextBox(weeklyPlanDeckText_(label,'',38),x+10,y+6,w-16,10); text.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor(accent || '#FDE68A');
}
function weeklyPlanDeckSlide_(slide, accent, heading, lines, layoutIndex, plan, visuals) {
  try { slide.getPageElements().forEach(function(el){ el.remove(); }); } catch(ignore) {}
  var clean=(lines || []).filter(Boolean).slice(0,4), mode=Number(layoutIndex || 0);
  weeklyPlanDeckFrame_(slide,accent,mode===0?'01 / OPPORTUNITY LANDSCAPE':mode===1?'02 / DIAGNOSIS LAB':'03 / JOINT ACTION DESIGN',mode+3);
  var title=slide.insertTextBox(weeklyPlanDeckText_(heading,'Meeting focus',72),40,70,615,48); title.getText().getTextStyle().setFontSize(27).setBold(true).setForegroundColor('#F8FAFC');
  if (mode===0) {
    var lead=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,40,132,278,205); lead.getFill().setSolidFill('#192235'); try {lead.getBorder().setTransparent();} catch(ignoreA) {}
    var leadLabel=slide.insertTextBox('THE CONVERSATION STARTER',61,153,220,12); leadLabel.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#93C5FD');
    var leadCopy=slide.insertTextBox(weeklyPlanDeckText_(clean[0] || weeklyPlanMerchantSafeObjective_(plan && plan.objective),'',128),61,181,225,75); leadCopy.getText().getTextStyle().setFontSize(17).setBold(true).setForegroundColor('#F8FAFC');
    weeklyPlanDeckPill_(slide,'CUSTOMER EXPERIENCE',61,287,120,'#60A5FA');
    weeklyPlanDeckPill_(slide,'CONVERSION',190,287,92,'#34D399');
    clean.slice(1,4).forEach(function(line,index){
      var y=139+index*65, rail=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,351,y,5,44); rail.getFill().setSolidFill(['#E23744','#F59E0B','#34D399'][index]); try {rail.getBorder().setTransparent();} catch(ignoreB) {}
      var n=slide.insertTextBox('0'+(index+1),370,y+3,25,12); n.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#94A3B8');
      var txt=slide.insertTextBox(weeklyPlanDeckText_(line,'',135),401,y,246,38); txt.getText().getTextStyle().setFontSize(12).setForegroundColor('#E2E8F0');
    });
    var rule=slide.insertTextBox('Start with the customer outcome. Then agree the operational move that makes it possible.',40,349,580,14); rule.getText().getTextStyle().setFontSize(10).setBold(true).setForegroundColor('#FDE68A');
  } else if (mode===1) {
    var columns=[{label:'SIGNAL',color:'#60A5FA'},{label:'WHAT IT MEANS',color:'#FBBF24'},{label:'WHAT TO CHECK',color:'#34D399'}];
    columns.forEach(function(col,index){
      var x=40+index*215, box=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,x,136,195,196); box.getFill().setSolidFill(index===1?'#202533':'#161C29'); try {box.getBorder().setTransparent();} catch(ignoreC) {}
      var tag=slide.insertTextBox(col.label,x+17,155,150,12); tag.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor(col.color);
      var body=weeklyPlanDeckText_(clean[index] || clean[clean.length-1] || 'Review the latest restaurant signal with the merchant.', '', 155);
      var copy=slide.insertTextBox(body,x+17,186,160,102); copy.getText().getTextStyle().setFontSize(index===1?15:13).setBold(index===1).setForegroundColor('#F8FAFC');
      var bar=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,x+17,304,158,3); bar.getFill().setSolidFill(col.color); try {bar.getBorder().setTransparent();} catch(ignoreD) {}
    });
    var lens=slide.insertTextBox('A good diagnosis separates the observed customer signal, its likely impact, and the precise question to resolve together.',40,351,625,14); lens.getText().getTextStyle().setFontSize(10).setBold(true).setForegroundColor('#CBD5E1');
  } else {
    var actionPanel=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,40,134,410,201); actionPanel.getFill().setSolidFill('#18352D'); try {actionPanel.getBorder().setTransparent();} catch(ignoreE) {}
    var actionLabel=slide.insertTextBox('MAKE THE NEXT MOVE REAL',61,153,260,13); actionLabel.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#86EFAC');
    clean.slice(0,3).forEach(function(line,index){
      var y=181+index*43, num=slide.insertShape(SlidesApp.ShapeType.ELLIPSE,62,y,22,22); num.getFill().setSolidFill(['#34D399','#FBBF24','#60A5FA'][index]); try {num.getBorder().setTransparent();} catch(ignoreF) {}
      var number=slide.insertTextBox(String(index+1),69,y+5,9,10); number.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#0D111B');
      var action=slide.insertTextBox(weeklyPlanDeckText_(line,'',150),96,y-1,320,30); action.getText().getTextStyle().setFontSize(12).setForegroundColor('#ECFDF5');
    });
    var pact=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,475,134,205,201); pact.getFill().setSolidFill('#251F25'); try {pact.getBorder().setTransparent();} catch(ignoreG) {}
    var pactTitle=slide.insertTextBox('THE CLOSE',496,154,145,12); pactTitle.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#FDA4AF');
    var pactBody=slide.insertTextBox('One promise.\nOne owner.\nOne review date.',496,186,148,76); pactBody.getText().getTextStyle().setFontSize(18).setBold(true).setForegroundColor('#F8FAFC');
    var pactNote=slide.insertTextBox('Capture it before the meeting ends.',496,286,145,22); pactNote.getText().getTextStyle().setFontSize(9).setForegroundColor('#CBD5E1');
    var footer=slide.insertTextBox('Brahmastra turns discussion into a jointly owned next step.',40,351,590,14); footer.getText().getTextStyle().setFontSize(10).setBold(true).setForegroundColor('#FDE68A');
  }
}

function weeklyPlanDeckExecutiveSlide_(slide, plan) {
  try { slide.getPageElements().forEach(function(el){el.remove();}); } catch(ignore) {}
  try { slide.getBackground().setSolidFill('#10131A'); } catch(ignore2) {}
  var band=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,0,0,720,16); band.getFill().setSolidFill('#E23744'); try {band.getBorder().setTransparent();} catch(ignore3) {}
  weeklyPlanDeckZomatoMark_(slide,594,28);
  var kicker=slide.insertTextBox('MEETING SCORECARD  /  JOINT GROWTH OUTCOME',40,48,370,14); kicker.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#FDA4AF');
  var title=slide.insertTextBox('The outcome we want from this conversation',40,73,620,35); title.getText().getTextStyle().setFontSize(25).setBold(true).setForegroundColor('#F8FAFC');
  var cards=[
    {h:'WHY TODAY',v:'Align on the restaurant’s current customer, operational and conversion opportunities.',c:'#E23744'},
    {h:'MEETING OBJECTIVE',v:weeklyPlanDeckText_(weeklyPlanMerchantSafeObjective_(plan.objective),'Agree the highest-impact growth action for this week.',115),c:'#60A5FA'},
    {h:'NEXT MILESTONE',v:weeklyPlanDeckText_(plan.nextAction,'Confirm an owner and due date before closing the meeting.',115),c:'#34D399'}
  ];
  cards.forEach(function(card,i){
    var x=40+i*215, box=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,x,137,198,185); box.getFill().setSolidFill('#181D28'); try {box.getBorder().setTransparent();} catch(cardIgnore) {}
    var rail=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,x,137,5,185); rail.getFill().setSolidFill(card.c); try {rail.getBorder().setTransparent();} catch(railIgnore) {}
    var h=slide.insertTextBox(card.h,x+18,157,160,13); h.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#94A3B8');
    var v=slide.insertTextBox(card.v,x+18,188,160,105); v.getText().getTextStyle().setFontSize(13).setForegroundColor('#E2E8F0');
  });
  var foot=slide.insertTextBox('This is a collaborative working session — align on one measurable business outcome.',40,365,625,13); foot.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#FDE68A');
}

function weeklyPlanDeckCommitmentSlide_(slide, plan, user) {
  try { slide.getPageElements().forEach(function(el){el.remove();}); } catch(ignore) {}
  try { slide.getBackground().setSolidFill('#10131A'); } catch(ignore2) {}
  var band=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,0,0,720,16); band.getFill().setSolidFill('#1C6B55'); try {band.getBorder().setTransparent();} catch(ignore3) {}
  weeklyPlanDeckZomatoMark_(slide,594,28);
  var kicker=slide.insertTextBox('CLOSE THE LOOP  /  LEAVE WITH CLARITY',40,48,355,14); kicker.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#86EFAC');
  var title=slide.insertTextBox('Our commitment for the next review',40,73,630,35); title.getText().getTextStyle().setFontSize(26).setBold(true).setForegroundColor('#F8FAFC');
  var objective=weeklyPlanDeckText_(weeklyPlanMerchantSafeObjective_(plan.objective),'Agree the highest-impact action for this week.',175);
  var objectiveBox=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,40,126,640,60); objectiveBox.getFill().setSolidFill('#18352D'); try {objectiveBox.getBorder().setTransparent();} catch(objectiveIgnore) {}
  var objectiveLabel=slide.insertTextBox('SUCCESS LOOKS LIKE',60,140,160,12); objectiveLabel.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#86EFAC');
  var objectiveText=slide.insertTextBox(objective,60,157,590,20); objectiveText.getText().getTextStyle().setFontSize(12).setForegroundColor('#ECFDF5');
  var fields=[['Merchant commitment',plan.merchantCommitment || 'Write the specific merchant commitment here'],['Named owner',plan.commitmentOwner || 'Merchant / KAM owner'],['Due date',plan.commitmentDueDate || plan.followUpDate || 'Confirm in meeting'],['Next review',plan.followUpDate || 'Confirm in meeting']];
  fields.forEach(function(field,i){
    var x=40+(i%2)*323,y=210+Math.floor(i/2)*74, box=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,x,y,306,57); box.getFill().setSolidFill('#181D28'); try {box.getBorder().setTransparent();} catch(fieldIgnore) {}
    var label=slide.insertTextBox(field[0].toUpperCase(),x+16,y+12,260,11); label.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#94A3B8');
    var value=slide.insertTextBox(weeklyPlanDeckText_(field[1],'To be confirmed',65),x+16,y+29,266,16); value.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#F8FAFC');
  });
  var bottom=slide.insertTextBox('Prepared for '+(plan.restaurant || 'merchant meeting')+' · KAM: '+(user.email || 'Brahmastra user'),40,370,620,13); bottom.getText().getTextStyle().setFontSize(9).setForegroundColor('#94A3B8');
}

function weeklyPlanDeckMetricCard_(slide, x, y, w, h, label, value, note, accent, valueColor) {
  var card=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,x,y,w,h); card.getFill().setSolidFill('#181D28'); try {card.getBorder().setTransparent();} catch(ignore) {}
  var rail=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,x,y,5,h); rail.getFill().setSolidFill(accent || '#E23744'); try {rail.getBorder().setTransparent();} catch(ignore2) {}
  var labelBox=slide.insertTextBox(String(label || '').toUpperCase(),x+16,y+15,w-28,13); labelBox.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#94A3B8');
  var valueBox=slide.insertTextBox(String(value || '—'),x+16,y+35,w-28,29); valueBox.getText().getTextStyle().setFontSize(20).setBold(true).setForegroundColor(valueColor || '#F8FAFC');
  var noteBox=slide.insertTextBox(weeklyPlanDeckText_(note || '', '', 55),x+16,y+h-25,w-28,13); noteBox.getText().getTextStyle().setFontSize(8).setForegroundColor('#CBD5E1');
}

/** Restaurant-only deck visuals. Values are read from the current portfolio/NOV
 * feeds so the deck talks about the exact restaurant selected for the meeting. */
function weeklyPlanDeckVisuals_(plan, user, clusterOverride) {
  var source=weeklyPlanSourceRows_(user.email, clusterOverride), id=normId_(plan.resId), row=null;
  (source.rows || []).forEach(function(r){
    if (normId_(weeklyPlanPick_(r,['res_id','res id','restaurant_id','restaurant id']))!==id) return;
    if (!row || weeklyPlanWeekSerial_(weeklyPlanPick_(r,['time_period','time period'])) >= weeklyPlanWeekSerial_(weeklyPlanPick_(row,['time_period','time period']))) row=r;
  });
  if (!row) return [];
  function value_(aliases) { return weeklyPlanPercent_(weeklyPlanPick_(row, aliases)); }
  function count_(aliases) { return weeklyPlanNumber_(weeklyPlanPick_(row, aliases)); }
  function ratio_(direct, numerator) {
    var denominator=count_(['sv','supply_value']);
    var n=count_(numerator); return denominator>0 ? n / denominator * 100 : 0;
  }
  var levers=[
    {label:'Ads / SV',value:ratio_(['ads_sv','ads/sv'],['ads_rev','ads_revenue','ad_revenue'])},
    {label:'MVD / SV',value:ratio_(['mvd_sv','mvd/sv','actual_mvd_sv'],['mvd','merchant_discount','promo_discount'])},
    {label:'Salt / SV',value:ratio_(['salt_sv','salt/sv'],['salt','salt_discount'])},
    {label:'ZVD / SV',value:ratio_(['zvd_sv','zvd/sv'],['zvd','zomato_discount'])}
  ].filter(function(x){return x.value>0;});
  var visuals=[];
  if (levers.length) {
    var topline=levers.map(function(x){return x.label+': '+weeklyPlanFmtPct_(x.value);});
    visuals.push({kind:'levers',title:'The growth levers to discuss', accent:'#273E7C', note:topline,
      metrics:{levers:levers},
      blob:weeklyPlanPieChartBlob_('Growth investment mix',levers)});
  }
  var nrl=[{label:'New',value:count_(['new_orders','new_order','new'])},{label:'Repeat',value:count_(['repeat_orders','repeat_order','repeat'])},{label:'Lapsed',value:count_(['lapsed_orders','lapsed_order','lapsed'])}];
  var pg=[{label:'PG 7–10',value:count_(['pg_7_10','pg7_10','pg_7_10_la'])},{label:'PG 4–6',value:count_(['pg_4_6','pg4_6','pg_4_6_mm'])},{label:'PG 1–3',value:count_(['pg_1_3','pg1_3','pg_1_3_um'])}];
  var meal=[{label:'Breakfast',value:count_(['breakfast_orders','breakfast'])},{label:'Lunch',value:count_(['lunch_orders','lunch'])},{label:'Evening',value:count_(['evening_orders','evening'])},{label:'Dinner',value:count_(['dinner_orders','dinner'])},{label:'Late night',value:count_(['late_night_orders','late_night','late night'])}];
  [["Customer mix · NRL",nrl,"New, repeat and lapsed orders"],["Customer mix · PG",pg,"PG segmentation by orders"],["Customer mix · Meal time",meal,"When customers place orders"]].forEach(function(spec, index){
    var total=spec[1].reduce(function(sum,x){return sum+x.value;},0); if (!total) return;
    visuals.push({kind:'segment',title:spec[0],accent:['#1C6B55','#9B5A18','#6B2C91'][index],note:spec[1].map(function(x){return x.label+': '+weeklyPlanFmtNum_(x.value)+' orders ('+weeklyPlanFmtPct_(x.value/total*100)+')';}),blob:weeklyPlanPieChartBlob_(spec[0],spec[1])});
  });
  return visuals;
}
function weeklyPlanPieChartBlob_(title, items) {
  var valid=(items || []).filter(function(item){return weeklyPlanNumber_(item.value)>0;}); if (!valid.length) return null;
  try {
    var table=Charts.newDataTable().addColumn(Charts.ColumnType.STRING,'Segment').addColumn(Charts.ColumnType.NUMBER,'Value');
    valid.forEach(function(item){table.addRow([String(item.label),weeklyPlanNumber_(item.value)]);});
    return Charts.newPieChart().setDataTable(table.build()).setTitle(title).setDimensions(500,270).build().getAs('image/png');
  } catch(ignore) { return null; }
}
function weeklyPlanDeckChartSlide_(slide, visual) {
  try { slide.getPageElements().forEach(function(el){el.remove();}); } catch(ignore) {}
  try { slide.getBackground().setSolidFill('#10131A'); } catch(ignore2) {}
  var accent=visual.accent || '#273E7C', band=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,0,0,720,16); band.getFill().setSolidFill(accent); try { band.getBorder().setTransparent(); } catch(ignore3) {}
  var kicker=slide.insertTextBox(visual.kind==='segment' ? 'CUSTOMER BEHAVIOUR' : 'COMMERCIAL LEVERS',40,48,250,14); kicker.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#94A3B8');
  var title=slide.insertTextBox(String(visual.title || 'Portfolio view'),40,73,640,35); title.getText().getTextStyle().setFontSize(25).setBold(true).setForegroundColor('#F8FAFC');
  if (visual.kind==='levers') {
    weeklyPlanDeckLeverSlide_(slide,visual);
    return;
  }
  var chartPanel=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,40,130,370,220); chartPanel.getFill().setSolidFill('#181D28'); try {chartPanel.getBorder().setTransparent();} catch(panelIgnore) {}
  if (visual.blob) { try { slide.insertImage(visual.blob,51,140,348,194); } catch(ignore4) {} }
  var notes=(visual.note || []).slice(0,5);
  notes.forEach(function(line,index){
    var y=145+index*37, marker=slide.insertShape(SlidesApp.ShapeType.ELLIPSE,440,y+6,11,11); marker.getFill().setSolidFill(accent); try {marker.getBorder().setTransparent();} catch(markerIgnore) {}
    var note=slide.insertTextBox(weeklyPlanDeckText_(line,'',80),462,y,212,25); note.getText().getTextStyle().setFontSize(12).setForegroundColor('#E2E8F0');
  });
  var foot=slide.insertTextBox('Brahmastra · Restaurant-level portfolio data',38,374,420,16); foot.getText().getTextStyle().setFontSize(9).setForegroundColor('#94A3B8');
}
// The customer page is always present.  When segmentation data is missing it
// still gives the KAM a clean, merchant-friendly conversation frame instead
// of producing a six-slide deck with an unexplained gap in the story.
function weeklyPlanDeckCustomerStorySlide_(slide, visual, plan) {
  weeklyPlanDeckFrame_(slide,(visual && visual.accent) || '#9B5A18','06 / CUSTOMER & OCCASION STORY',6);
  var title=slide.insertTextBox((visual && visual.title) || 'Build growth around the customer',40,70,620,42); title.getText().getTextStyle().setFontSize(27).setBold(true).setForegroundColor('#F8FAFC');
  var chartPanel=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,40,130,306,208); chartPanel.getFill().setSolidFill('#171D29'); try {chartPanel.getBorder().setTransparent();} catch(ignore) {}
  if (visual && visual.blob) {
    try { slide.insertImage(visual.blob,54,143,278,173); } catch(imageIgnore) {}
  } else {
    var ring=slide.insertShape(SlidesApp.ShapeType.ELLIPSE,132,164,122,122); ring.getFill().setSolidFill('#252E40'); try {ring.getBorder().setTransparent();} catch(ringIgnore) {}
    var ringText=slide.insertTextBox('CUSTOMER\nMOMENTS',155,204,82,35); ringText.getText().getTextStyle().setFontSize(12).setBold(true).setForegroundColor('#FDE68A');
    var empty=slide.insertTextBox('Use the meeting to understand who orders, when they order, and where the experience can improve.',63,292,260,26); empty.getText().getTextStyle().setFontSize(9).setForegroundColor('#CBD5E1');
  }
  var right=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,370,130,310,208); right.getFill().setSolidFill('#1B2231'); try {right.getBorder().setTransparent();} catch(rightIgnore) {}
  var label=slide.insertTextBox('WHAT TO EXPLORE TOGETHER',391,151,230,12); label.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#FDE68A');
  var prompts=(visual && visual.note) || [
    'Which customer occasions have the most headroom?',
    'What would improve repeat choice and conversion?',
    'Which menu, experience or value change can the merchant test first?'
  ];
  prompts.slice(0,3).forEach(function(item,index){
    var y=181+index*43, dot=slide.insertShape(SlidesApp.ShapeType.ELLIPSE,392,y+3,10,10); dot.getFill().setSolidFill(['#F59E0B','#60A5FA','#34D399'][index]); try {dot.getBorder().setTransparent();} catch(dotIgnore) {}
    var text=slide.insertTextBox(weeklyPlanDeckText_(item,'',93),410,y,242,28); text.getText().getTextStyle().setFontSize(11).setForegroundColor('#E2E8F0');
  });
  var footer=slide.insertTextBox('Customer data informs the conversation; the merchant and KAM decide the test worth running next.',40,352,620,14); footer.getText().getTextStyle().setFontSize(10).setBold(true).setForegroundColor('#CBD5E1');
}
function weeklyPlanDeckLeverSlide_(slide, visual) {
  var levers=((visual.metrics || {}).levers || []).slice(0,4);
  var title=slide.insertTextBox('Operational levers to discuss together',40,130,560,24); title.getText().getTextStyle().setFontSize(19).setBold(true).setForegroundColor('#F8FAFC');
  if (!levers.length) {
    var empty=slide.insertTextBox('Use the restaurant’s latest hygiene, funnel, ads and promotion signals to agree the next joint action.',40,180,620,50); empty.getText().getTextStyle().setFontSize(15).setForegroundColor('#CBD5E1');
  }
  levers.forEach(function(lever,index) {
    var x=40+(index%2)*320, y=175+Math.floor(index/2)*82;
    weeklyPlanDeckMetricCard_(slide,x,y,285,65,String(lever.label),weeklyPlanFmtPct_(lever.value),'latest portfolio-calculated value',['#60A5FA','#34D399','#FBBF24','#C084FC'][index]);
  });
  var foot=slide.insertTextBox('Discuss only applicable levers, agree one owner and one review date before closing the meeting.',40,377,640,13); foot.getText().getTextStyle().setFontSize(9).setForegroundColor('#FDE68A');
}
function weeklyPlanDeckPrioritySlide_(slide, plan, visual) {
  try { slide.getPageElements().forEach(function(el){el.remove();}); } catch(ignore) {}
  try { slide.getBackground().setSolidFill('#10131A'); } catch(ignore2) {}
  var band=slide.insertShape(SlidesApp.ShapeType.RECTANGLE,0,0,720,16); band.getFill().setSolidFill('#E23744'); try {band.getBorder().setTransparent();} catch(ignore3) {}
  var kicker=slide.insertTextBox('MEETING SCORECARD  /  JOINT OPPORTUNITY',40,48,380,14); kicker.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#FDA4AF');
  var title=slide.insertTextBox('The operational opportunities we will address together',40,73,640,37); title.getText().getTextStyle().setFontSize(25).setBold(true).setForegroundColor('#F8FAFC');
  var levers=(((visual || {}).metrics || {}).levers || []).slice(0,4);
  if (!levers.length) levers=[{label:'Customer experience',value:null},{label:'Conversion',value:null},{label:'Ads & discovery',value:null},{label:'Promotions',value:null}];
  levers.forEach(function(lever,index) {
    weeklyPlanDeckMetricCard_(slide,40+index*160,130,150,108,lever.label,lever.value==null?'Review':weeklyPlanFmtPct_(lever.value),'latest portfolio-calculated measure',['#E23744','#1C6B55','#F59E0B','#273E7C'][index]);
  });
  var rationale=weeklyPlanDeckText_(weeklyPlanMerchantSafeObjective_(plan.objective), '', 245);
  var reasonBox=slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE,40,265,640,75); reasonBox.getFill().setSolidFill('#231D24'); try {reasonBox.getBorder().setTransparent();} catch(reasonIgnore) {}
  var label=slide.insertTextBox('WHY THIS CONVERSATION MATTERS',60,281,270,13); label.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#FDA4AF');
  var reason=slide.insertTextBox(rationale,60,301,585,28); reason.getText().getTextStyle().setFontSize(13).setForegroundColor('#FCE7F3');
  var foot=slide.insertTextBox('Use current portfolio-calculated measures to agree an owner and a review date.',40,376,560,13); foot.getText().getTextStyle().setFontSize(9).setForegroundColor('#94A3B8');
}

/** Fetch an AI-written deck outline and an optional generated cover image. */
function weeklyPlanAiDeckPackage_(plan, user) {
  var fallback = {deck:weeklyPlanStaticDeckContent_(plan,user), usedAi:false, imagePath:'', config:null, warning:''};
  var merchantPlan = {restaurant:plan.restaurant,resId:plan.resId,city:plan.city,cluster:plan.cluster,meetingDate:plan.meetingDate,meetingTime:plan.meetingTime,objective:weeklyPlanMerchantSafeObjective_(plan.objective),talkingPoints:weeklyPlanMerchantSafeTalkingPoints_(plan.talkingPoints),nextAction:plan.nextAction,followUpDate:plan.followUpDate};
  var cfg = weeklyPlanAiConfig_();
  if (!cfg.endpointUrl || cfg.provider === 'huggingface') {
    fallback.warning = cfg.endpointUrl ? 'The selected endpoint does not support deck visuals yet.' : 'No AI endpoint is linked.';
    return fallback;
  }
  try {
    var prompt = [
      'You are Brahmastra AI creating an executive-quality, editable merchant-facing growth collaboration deck.',
      'Use only the supplied plan data. Do not invent numbers, targets, causes, promises or operational facts.',
      'Write polished, concise Indian-business English that a restaurant owner can understand immediately.',
      'Make the narrative constructive and collaborative: show opportunity, explain the customer impact, agree a joint action and make the next review clear.',
      'Never mention NOV, CM, targets, actuals, gaps, achievement, score, KAM priority, lead list, dashboard rule, algorithm or Wallet Share in the slide copy. These are internal signals, not merchant-facing content.',
      'This is a fixed premium 7-slide presentation template: Cover, commercial scorecard, growth opportunity, diagnosis, customer behaviour visual, joint action plan, commitment close. You write copy ONLY for the following three named narrative pages.',
      'Return JSON only, without markdown or code fences, using exactly this shape:',
      '{"cover":{"title":"short title","subtitle":"short outcome-led subtitle","image_prompt":"a text-free premium restaurant visual prompt"},"slides":[{"title":"The growth opportunity","bullets":["...","..."]},{"title":"What we will diagnose together","bullets":["...","..."]},{"title":"The joint action plan","bullets":["...","..."]}]}',
      'Return exactly 3 slides, in that order. Each slide must have 2 to 4 short, specific bullets. Use exact numbers only when they are supplied. The image prompt must have no text, logo, numbers or labels.',
      'Review the complete operational picture, not only visibility or rating. Where data exists, cover the most material conditions across hygiene, funnel, ads, promos/discounts, merchant share, pricing/value and customer segmentation.',
      'Every recommendation must begin with the factual condition and values that trigger it (for example: "Ads/CV is 4.2% versus a 7.0% benchmark — jointly agree..."). Do not mention a category with no evidence in the supplied data.',
      weeklyPlanMetricPlaybook_(),
      'Meeting plan and complete restaurant scorecard JSON:', JSON.stringify({meetingPlan:merchantPlan,fullRestaurantMetrics:weeklyPlanDeckSafeMetrics_(plan.aiMetrics || {})})
    ].join('\n');
    var req = cfg.provider === 'colab-qwen' ? {task:'weekly_deck_package',message:prompt,context:{plan:merchantPlan}} : {task:'weekly_deck_package',inputs:prompt,context:{plan:merchantPlan}};
    var data = weeklyPlanAiRequest_(cfg, req);
    var deck = weeklyPlanAiNormaliseDeck_(data.deck || data.output || data, plan, user);
    if (!deck) { fallback.warning='AI returned a deck response in an unsupported format.'; return fallback; }
    return {deck:deck, usedAi:true, imagePath:String(data.image_path || data.imagePath || ''), config:cfg, warning:''};
  } catch(e) {
    fallback.warning = 'AI deck copy was unavailable; a standard editable deck was created instead.';
    return fallback;
  }
}
function weeklyPlanAiRequest_(cfg, request) {
  if (cfg.provider === 'openai') {
    var openAiInput = String(request.message || request.inputs || request.input || '');
    var openAiResponse = UrlFetchApp.fetch(cfg.endpointUrl, {
      method:'post', contentType:'application/json',
      headers:{Authorization:'Bearer ' + cfg.token},
      payload:JSON.stringify({model:cfg.model || 'gpt-5-mini', input:openAiInput, reasoning:{effort:'low'}, max_output_tokens:2200, store:false}),
      muteHttpExceptions:true
    });
    var openAiCode=openAiResponse.getResponseCode(), openAiRaw=openAiResponse.getContentText(), openAiData={};
    try { openAiData=JSON.parse(openAiRaw); } catch(ignoreOpenAi) {}
    if (openAiCode < 200 || openAiCode >= 300) throw new Error((openAiData.error && openAiData.error.message) || ('OpenAI request failed ('+openAiCode+').'));
    var openAiText=weeklyPlanOpenAiText_(openAiData), openAiJson=weeklyPlanAiJson_(openAiText);
    return openAiJson || {output:openAiText, reply:openAiText};
  }
  var headers = {}; if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
  var response = UrlFetchApp.fetch(cfg.endpointUrl, {method:'post',contentType:'application/json',headers:headers,payload:JSON.stringify(request),muteHttpExceptions:true});
  var code=response.getResponseCode(), raw=response.getContentText(), data={};
  try { data=JSON.parse(raw); } catch(ignore) {}
  if (code < 200 || code >= 300) throw new Error((data.error && data.error.message) || ('AI request failed ('+code+').'));
  return Array.isArray(data) ? (data[0] || {}) : data;
}
function weeklyPlanOpenAiText_(data) {
  if (!data) return '';
  function plainText_(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(plainText_).filter(Boolean).join('\n');
    if (typeof value === 'object') return plainText_(value.value || value.text || value.output_text || value.content || '');
    return '';
  }
  var direct=plainText_(data.output_text || data.text || (data.response && (data.response.output_text || data.response.text)) || (data.data && (data.data.output_text || data.data.text)));
  if (direct) return direct.trim();
  var parts=[];
  var outputs=data.output || (data.response && data.response.output) || (data.data && data.data.output) || [];
  (Array.isArray(outputs) ? outputs : [outputs]).forEach(function(item){
    if (item && item.text) parts.push(plainText_(item.text));
    (item.content || []).forEach(function(block){
      if (!block) return;
      if (block.type === 'output_text' || block.type === 'text' || block.text != null || block.output_text != null) {
        parts.push(plainText_(block.text || block.output_text || block.content));
      }
    });
  });
  if (!parts.length && data.choices && data.choices[0] && data.choices[0].message) parts.push(plainText_(data.choices[0].message.content));
  return parts.join('\n').trim();
}
// The weekly planner must never fail merely because an inference provider
// returns an accepted-but-empty response. The deterministic Brahmastra plan is
// already data-backed and remains the safe fallback for all AI entry points.
function weeklyPlanAiFallbackText_(payload, isDeepDive) {
  payload=payload || {};
  if (isDeepDive) {
    var plan=String(payload.ruleBasedPlan || '').trim();
    return [
      'KEY INSIGHTS',
      '• The restaurant has been prioritised from the current, LM, L2M and Cuisine × City benchmark metrics supplied to Brahmastra.',
      '• The action plan below uses the approved dashboard rules and only the available restaurant data.',
      '• Re-run Auto Analyse after the next data refresh for an additional AI narrative.',
      '',
      'PRIORITISED ACTION PLAN',
      plan || '• Review the current portfolio metrics and agree the highest-impact owner-led action.',
      '',
      'WHY THIS MATTERS',
      '• Closing the highest-priority gap improves the restaurant’s weekly growth outcome.',
      '',
      'MERCHANT TALK TRACK',
      '• Confirm the root cause with the merchant.',
      '• Agree one measurable action, owner and due date.',
      '• Review progress in the next KAM follow-up.'
    ].join('\n');
  }
  return [
    'MEETING TALKING POINTS',
    '• CONDITION: Review Ads/CV, delivery, ROI, order contribution, coverage and Grow Max from the available data. Question/action: agree the strongest supported ads action. Expected commitment: one measurable ads action. Owner: KAM / Merchant. Due date: agreed in meeting.',
    '• CONDITION: Review MVD/SV, Salt/SV, promo order contribution, ZVD/SV and merchant funding from the available data. Question/action: agree the strongest supported promo action. Expected commitment: one measurable promo action. Owner: KAM / Merchant. Due date: agreed in meeting.',
    '• CONDITION: Review the strongest remaining funnel, hygiene or customer-segmentation signal. Question/action: confirm the root cause. Expected commitment: one measurable correction. Owner: named owner. Due date: agreed in meeting.'
  ].join('\n');
}
function weeklyPlanAiJson_(text) {
  text=String(text || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(text); } catch(ignore) { return null; }
}
function weeklyPlanAiNormaliseDeck_(source, plan, user) {
  if (!source || typeof source !== 'object') return null;
  var cover=source.cover || {}, slides=source.slides;
  if (!Array.isArray(slides) || !slides.length) return null;
  return {
    cover:{title:weeklyPlanDeckText_(cover.title, 'Brahmastra · ' + (plan.restaurant || 'Merchant meeting'), 94),subtitle:weeklyPlanMerchantSafeText_(cover.subtitle, 'Weekly merchant growth meeting', 175)},
    slides:slides.slice(0,3).map(function(item,index){
      item=item || {};
      return {accent:['#E23744','#273E7C','#1C6B55'][index],heading:['The growth opportunity','What we will diagnose together','The joint action plan'][index],bullets:weeklyPlanMerchantSafeDeckList_(item.bullets || item.points || item.content, weeklyPlanMerchantSafeObjective_(plan.objective || plan.nextAction))};
    })
  };
}
function weeklyPlanMerchantSafeText_(value, fallback, max) {
  var text=weeklyPlanMerchantSafeTalkingPoints_(value);
  return weeklyPlanDeckText_(text, fallback, max);
}
function weeklyPlanMerchantSafeDeckList_(value, fallback) {
  var blocked=/(^|[^a-z])(nov|cm)([^a-z]|$)|\btarget\b|\bachievement\b|\bgap\b|\bpriority\b|\blead list\b|wallet\s*share/i;
  var list=weeklyPlanDeckList_(value, fallback).filter(function(item){ return !blocked.test(String(item)); });
  return list.length ? list : weeklyPlanDeckList_(weeklyPlanMerchantSafeObjective_(fallback), 'Review the customer, operational and conversion levers together.');
}
function weeklyPlanDeckSafeMetrics_(value) {
  if (Array.isArray(value)) return value.map(weeklyPlanDeckSafeMetrics_);
  if (!value || typeof value !== 'object') return value;
  var out={};
  Object.keys(value).forEach(function(key){
    if (/wallet[ _-]*share/i.test(String(key))) return;
    out[key]=weeklyPlanDeckSafeMetrics_(value[key]);
  });
  return out;
}
function weeklyPlanAiDeckImage_(imagePath, cfg) {
  if (cfg && cfg.provider === 'openai') return null;
  if (!imagePath || !cfg || !cfg.endpointUrl || !/^\/?generated\/[a-zA-Z0-9_.-]+$/.test(String(imagePath))) return null;
  try {
    var base=String(cfg.endpointUrl).replace(/\/api\/chat\/?$/i,'').replace(/\/$/,'');
    var headers={}; if (cfg.token) headers.Authorization='Bearer '+cfg.token;
    var response=UrlFetchApp.fetch(base + '/' + String(imagePath).replace(/^\//,''),{headers:headers,muteHttpExceptions:true});
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return null;
    return response.getBlob().setName('brahmastra-ai-cover.jpg');
  } catch(ignore) { return null; }
}

/** Global Hugging Face / Colab model connector for the copied dashboard. */
function getWeeklyPlanAiConfig(viewer, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam), cfg = weeklyPlanAiConfig_();
  return {provider:cfg.provider || 'custom', modelLink:cfg.modelLink || '', endpointUrl:cfg.endpointUrl || '', hasToken:!!cfg.token, enabled:!!cfg.endpointUrl, canManage:!!user.isAdmin};
}
function saveWeeklyPlanAiConfig(config, viewer, clusterOverride, viewAsKam) {
  config = config || {};
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam), old = weeklyPlanAiConfig_();
  if (!user.isAdmin) throw new Error('Only a dashboard admin can change the global AI connection.');
  var endpointUrl = String(config.endpointUrl || '').trim();
  var modelLink = String(config.modelLink || '').trim();
  var provider = String(config.provider || 'custom');
  // Colab Qwen always exposes this exact Flask route.  Accept either the
  // tunnel base URL or the full route and repair accidental duplicate pastes.
  if (provider === 'colab-qwen' && endpointUrl) {
    endpointUrl = endpointUrl.replace(/\/+$/, '').replace(/(?:\/api\/chat)+$/i, '');
    endpointUrl += '/api/chat';
  }
  if (endpointUrl && !/^https:\/\//i.test(endpointUrl)) throw new Error('Inference endpoint must begin with https://');
  var cfg = {provider:provider, modelLink:modelLink, endpointUrl:endpointUrl, token:String(config.token || '').trim() || old.token || ''};
  PropertiesService.getScriptProperties().setProperty(WEEKLY_PLAN_GLOBAL_AI_PROP_, JSON.stringify(cfg));
  return {provider:cfg.provider, modelLink:cfg.modelLink, endpointUrl:cfg.endpointUrl, hasToken:!!cfg.token, enabled:!!cfg.endpointUrl, canManage:true};
}

/**
 * Runs an automatic dashboard analysis through the globally linked model.
 * The dashboard builds the complete context itself; no user chat/message input
 * is ever required in the UI.  This works for Weekly Plan and Deep Dive.
 */
function weeklyPlanMetricPlaybook_(){return [
  'METRIC PLAYBOOK — apply only when the named source values exist; never invent missing values.',
  'SV means pure SV only; never add packaging charges to a denominator. Compare CM with LM and L2M; use Cuisine × City benchmark average and maximum where available. Do not benchmark hygiene or commission.',
  'Review flags: P.E., Ads, AR, GM1/GM2/GM3, SGM, MVD, Salt, veg mix and cart-breaker type.',
  'Hygiene: rating, thumbnail, menu score, images, descriptions and visibility.',
  'Top-line: orders, SV, CV, NOV/PO, ASV and ACV. NOV is internal and must never be shown to the merchant.',
  'Wallet share: commission revenue/SV, Ads/SV, MVD/SV and Salt/SV.',
  'Funnel: impressions, menu opens, I2M, M2C, C2O, M2O and I2O.',
  'Competition: cuisine impressions/OV, Impression RMS and OV RMS. Benchmark NOV/PO and ASV only.',
  'Ads: dependency/OV%, ROI, monthly booked, delivery, billed BAU/GM, Ads/CV BAU/GM, CPC, restaurant coverage and CV coverage.',
  'Promos: coded/Salt/discount OV%, MVD/ZVD/TVD per SV, merchant/Zomato share, P.E. intended/actual MVD and share, Salt/SV, MVD/P.E./Salt coverage.',
  'Segmentation: New/Repeat/Lapsed; PG 7–10, 4–6, 1–3; breakfast/lunch/evening/dinner/late night.',
  'Growth summary: state CM MoM/Mo2M trend, OV RMS trend, Impression RMS vs OV RMS; trigger impression/menu-open opportunity only when problematic; otherwise trigger the weak I2M/M2C/C2O step.',
  'Impressions: flag below benchmark and RMS declines. If Ads/CV falls vs LM/L2M or benchmark, state comparison and benchmark-supported lift. If GM1/GM2 is inactive, recommend enabling the applicable GM program. If Ads ROI >=2.5, productive Ads/CV can be increased after delivery and coverage validation.',
  'I2M: flag decline or below benchmark. Actions: add thumbnail if absent; rating below 4 needs a customer-experience owner; if MVD and Salt inactive, activate the supported offer.',
  'M2C: flag decline or below benchmark. Menu score below 80 needs images/descriptions. MVD/SV below trend/benchmark should move toward the supported benchmark.',
  'C2O: flag decline or below benchmark. MVD/SV below trend/benchmark should move toward the supported benchmark.',
  'ZVD/SV may be reduced when excessive. Ads, MVD and Salt are growth/investment levers: do not recommend reducing them merely because they are high.',
  'Where available add city searches, segmentation-wise funnel, price-hike trend and 3-month margin scenario using price increase and food-cost input.'
].join('\n');}

function generateBrahmastraAiAnalysis(payload, viewer, clusterOverride, viewAsKam) {
  payload = payload || {};
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam), cfg = weeklyPlanAiConfig_();
  if (!cfg.endpointUrl) throw new Error('Link your Hugging Face / Colab inference endpoint from Link AI first.');
  var isDeepDive = payload.analysisType === 'restaurant_deep_dive';
  var fullMetrics={};
  if (!isDeepDive && payload.resId) {
    try { fullMetrics=weeklyPlanAiMetricsForPlan_(payload, user, clusterOverride); } catch(fullMetricIgnore) {}
  }
  // Meeting preparation is shared with merchants. Internal performance
  // measures may still rank a visit, but must never reach the AI prompt or
  // merchant-facing output.
  var merchantPayload=isDeepDive ? payload : {
    restaurant:payload.restaurant, resId:payload.resId, city:payload.city, cluster:payload.cluster,
    objective:weeklyPlanMerchantSafeObjective_(payload.objective),
    talkingPoints:weeklyPlanMerchantSafeTalkingPoints_(payload.talkingPoints),
    nextAction:payload.nextAction, followUpDate:payload.followUpDate
  };
  var merchantMetrics=isDeepDive ? (payload.metrics || {}) : weeklyPlanMerchantSafeMetrics_(fullMetrics || {});
  var prompt = isDeepDive ? [
    'You are Brahmastra AI, a senior restaurant-growth analyst writing for a KAM.',
    'Analyse only the supplied metrics. Never invent numbers, causes, targets, facts or actions.',
    'Restaurant: ' + String(payload.restaurant || 'Not specified'),
    'City / Cuisine: ' + String(payload.city || '') + ' / ' + String(payload.cuisine || ''),
    'Current, LM, L2M and Cuisine×City benchmark metrics JSON:',
    JSON.stringify(payload.metrics || {}),
    '',
    'This is a strict AI-only assessment. Do not restate, refine, quote, or rely on any rule-based dashboard action plan.',
    'Infer the highest-impact growth levers from the supplied restaurant, trend and benchmark data only.',
    'Use the supplied Cuisine × City benchmark only. Do not use a city-wide assumption.',
    'Every factual bullet must name its metric and quote the current value plus LM, L2M or benchmark value whenever supplied.',
    'For a target, use only a capped / benchmark target that is explicitly supported by the dashboard rules.',
    'Return 400-650 words of plain text only with these headings and no introduction:',
    'KEY INSIGHTS (exactly 3 fact-led bullets: performance trend, benchmark gap, and growth bottleneck)',
    'PRIORITISED ACTION PLAN (4-6 bullets; prefix each with P0, P1 or P2; state owner action, metric and intended outcome)',
    'WHY THIS MATTERS (exactly 2 business-impact bullets)',
    'MERCHANT TALK TRACK (exactly 3 concise, merchant-ready bullets)',
    'Do not say "consider", "improve", or "increase" without naming the exact action, metric and intended outcome.',
    'If a value is unavailable, say it is unavailable; never replace it with a generic statement.'
  ].join('\n') : [
    'You are a concise merchant-growth meeting assistant for a restaurant KAM.',
    'Create only practical, evidence-led meeting talking points. Do not invent performance numbers or claim unseen data.',
    'Restaurant: ' + String(payload.restaurant || 'Not specified'),
    'Res ID: ' + String(payload.resId || 'Not specified'),
    'City: ' + String(payload.city || 'Not specified'),
    'Cluster: ' + String(payload.cluster || 'Not specified'),
    'Meeting objective: ' + String(merchantPayload.objective || 'Not specified'),
    'Existing notes: ' + String(merchantPayload.talkingPoints || 'None'),
    'Existing next action: ' + String(payload.nextAction || 'None'),
    'Complete calculated restaurant metric context JSON:',
    JSON.stringify(merchantMetrics),
    '',
    weeklyPlanMetricPlaybook_(),
    '',
    'This is merchant-facing. Never mention internal NOV/CM values, internal achievement gaps, score, KAM priority, lead lists, internal dashboard rules, or Wallet Share. Actual versus intended MVD/SV and merchant share are merchant discussion metrics and must be shown when supplied.',
    'Inspect every supplied category with data: hygiene, funnel, ads, promos/discounts, merchant share, pricing/value, customer segmentation, operating flags and Grow Max/Gmaxx model. Use only categories that have actual data.',
    'Return exactly three non-duplicative merchant conversations in this order: (1) one Ads point using Ads/CV, delivery, ROI, order contribution, coverage or Grow Max; (2) one Promo point using MVD/SV, Salt/SV, promo order contribution, ZVD/SV or merchant share; (3) the strongest remaining lever from Funnel, Hygiene, Customer Segmentation, Pricing or operating flags.',
    'Do not use, calculate, mention or infer CTR. CTR is excluded from this Beat Plan.',
    'Use natural merchant language. Do not expose raw field names such as Ad_Impressions, cpc, m2c or JSON keys. Translate them into readable labels.',
    'For each point, state a short insight first and quote only the two or three values needed to support it. Use CM, LM, L2M or Cuisine × City benchmark only when relevant.',
  'Explicitly surface actual versus intended MVD/SV, actual versus intended merchant share and active Gmaxx/GM flags when present. SV means pure SV only; packaging charges are separate.',
    'Ads and Promos must each receive one point. The third point must be the strongest supported non-Ads/non-Promo lever. If a category has limited data, say what must be validated instead of inventing a value.',
    'Return plain text only with exactly one heading: MEETING TALKING POINTS.',
    'Under it return exactly 3 concise merchant-ready bullets. Use this exact syntax for every bullet: CONDITION: short readable insight with selected evidence. Question/action: one discussion question or action. Expected commitment: one measurable commitment. Owner: named role. Due date: proposed date.',
    'Do not add a meeting goal, diagnosis section, risks section, follow-up message or any other heading.'
  ].join('\n');
  var headers = {};
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
  var request = cfg.provider === 'openai' ?
    {model:cfg.model || 'gpt-5-mini', input:prompt, reasoning:{effort:'low'}, max_output_tokens:isDeepDive ? 2200 : 1400, store:false} :
    (cfg.provider === 'huggingface' ?
    {inputs:prompt, parameters:{max_new_tokens:700,temperature:0.45,return_full_text:false}, options:{wait_for_model:true}} :
    (cfg.provider === 'colab-qwen' ?
      {message:prompt, context:isDeepDive ? payload : merchantPayload, task:isDeepDive ? 'restaurant_deep_dive' : 'weekly_meeting_prep'} :
      {task:isDeepDive ? 'restaurant_deep_dive' : 'weekly_meeting_prep', inputs:prompt, context:isDeepDive ? payload : merchantPayload, parameters:{max_new_tokens:700,temperature:0.45}}));
  var response = UrlFetchApp.fetch(cfg.endpointUrl, {
    method:'post', contentType:'application/json',
    headers:headers,
    payload:JSON.stringify(request),
    muteHttpExceptions:true
  });
  var code = response.getResponseCode(), raw = response.getContentText();
  var data = {};
  try { data = JSON.parse(raw); } catch(e) {}
  if (code < 200 || code >= 300) throw new Error((data.error && data.error.message) || 'AI request failed (' + code + ').');
  var first = Array.isArray(data) ? (data[0] || {}) : data;
  var text = cfg.provider === 'openai' ? weeklyPlanOpenAiText_(data) : String(first.reply || first.generated_text || first.text || first.response || first.output || (first.data && (first.data.text || first.data.output)) || '').trim();
  if (!text && isDeepDive) {
    try { Logger.log('OpenAI returned an empty restaurant analysis response.'); } catch(ignoreLog) {}
    throw new Error('AI returned no analysis. Please run Auto Analyse again.');
  }
  if (!text) {
    try { Logger.log('OpenAI returned an empty analysis response; using Brahmastra fallback.'); } catch(ignoreLog) {}
    text=weeklyPlanAiFallbackText_(isDeepDive ? payload : merchantPayload, isDeepDive);
    return {ok:true, text:text, fallback:true};
  }
  return {ok:true, text:text, fallback:false};
}

/** Removes internal ranking/performance fields before data is sent to a
 * merchant-facing AI request. Non-internal metrics remain intact so the AI
 * can discuss ads, discounts, hygiene, funnel and segmentation in context. */
function weeklyPlanMerchantSafeMetrics_(value) {
  if (Array.isArray(value)) return value.map(weeklyPlanMerchantSafeMetrics_);
  if (!value || typeof value !== 'object') return value;
  // NOV and internal commercial targets remain private. CM/LM/L2M prefixes
  // on operational metrics are retained because the meeting uses their trend.
  var output={}, blocked=/(^|_)nov(_|$)|(^|_)ctr(_|$)|(^|_)(cm_target|cm_actual|target_cm|actual_cm)(_|$)|target|achievement|gap|priority|score/i;
  Object.keys(value).forEach(function(key) {
    if (blocked.test(String(key))) return;
    output[key]=weeklyPlanMerchantSafeMetrics_(value[key]);
  });
  return output;
}

// Legacy wrapper retained so any already deployed client cache keeps working.
function generateWeeklyPlanAiPrep(payload, viewer, clusterOverride, viewAsKam) {
  return generateBrahmastraAiAnalysis(payload, viewer, clusterOverride, viewAsKam);
}

function weeklyPlanAiConfig_() {
  var openAiKey=String(PropertiesService.getScriptProperties().getProperty(WEEKLY_PLAN_OPENAI_KEY_PROP_) || '').trim();
  if (openAiKey) return {provider:'openai', endpointUrl:'https://api.openai.com/v1/responses', token:openAiKey, model:'gpt-5-mini', enabled:true};
  var raw = PropertiesService.getScriptProperties().getProperty(WEEKLY_PLAN_GLOBAL_AI_PROP_);
  try { return raw ? JSON.parse(raw) : {}; } catch(e) { return {}; }
}

function updateWeeklyPlanStatus(planId, status, viewer, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  var sheet = weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows = sheet.getDataRange().getValues();
  for (var r=1; r<rows.length; r++) {
    if (String(rows[r][0]) === String(planId) && String(rows[r][3]).toLowerCase() === user.email) {
      sheet.getRange(r+1,16).setValue(status);
      sheet.getRange(r+1,17).setValue(new Date());
      if (status === 'Closed') sheet.getRange(r+1,18).setValue(new Date());
      return {ok:true, plans:weeklyPlanRows_(user.email, rows[r][1]), team:weeklyPlanTeamReview_(user, rows[r][1])};
    }
  }
  throw new Error('This meeting plan is not available for your account.');
}

/** Records actual field execution. A check-in creates a real timestamp, while
 * an outcome and merchant commitment close the loop on the planned visit. */
function updateWeeklyPlanExecution(planId, payload, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), now=weeklyPlanDateTime_(new Date()); payload=payload||{};
  for (var r=1;r<rows.length;r++) {
    if (String(rows[r][0])===String(planId) && String(rows[r][3]||'').toLowerCase()===user.email) {
      var rowNo=r+1, current=rows[r], status=String(payload.status || current[15] || 'Planned');
      sheet.getRange(rowNo,16).setValue(status);
      sheet.getRange(rowNo,17).setValue(new Date());
      if (payload.checkIn && !current[25]) sheet.getRange(rowNo,26).setValue(now);
      if (payload.checkOut) sheet.getRange(rowNo,27).setValue(now);
      if (payload.meetingOutcome != null) sheet.getRange(rowNo,22).setValue(String(payload.meetingOutcome));
      if (payload.merchantCommitment != null) sheet.getRange(rowNo,23).setValue(String(payload.merchantCommitment));
      if (payload.commitmentOwner != null) sheet.getRange(rowNo,24).setValue(String(payload.commitmentOwner));
      if (payload.commitmentDueDate != null) {
        var oldDue=weeklyPlanDate_(current[24]), newDue=weeklyPlanDate_(payload.commitmentDueDate);
        sheet.getRange(rowNo,25).setValue(newDue);
        if (newDue !== oldDue) sheet.getRange(rowNo,44).setValue('');
        if (newDue) ensureWeeklyPlanReminderTrigger_();
      }
      if (payload.meetingType != null) sheet.getRange(rowNo,43).setValue(String(payload.meetingType).toLowerCase()==='call' ? 'Call' : 'Physical');
      if (status==='Closed') sheet.getRange(rowNo,18).setValue(current[17] || new Date());
      return {ok:true, plans:weeklyPlanRows_(user.email, current[1]), team:weeklyPlanTeamReview_(user, current[1])};
    }
  }
  throw new Error('This meeting plan is not available for your account.');
}

/** Field arrival is stored separately from the meeting. This lets a KAM prove
 * that they reached the merchant before starting the conversation/recording. */
function markWeeklyPlanArrival(planId, arrival, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), now=weeklyPlanDateTime_(new Date()), data=arrival||{};
  for (var r=1;r<rows.length;r++) {
    if (String(rows[r][0])!==String(planId) || String(rows[r][3]||'').toLowerCase()!==user.email) continue;
    var rowNo=r+1, rawType=String(data.visitLocationType || 'Merchant outlets'), type=rawType==='Corporate Office'?'Corporate Office':rawType==='Somewhere Else'?'Somewhere Else':'Merchant outlets';
    var position=weeklyPlanRouteStart_(data);if(!position)throw new Error('A valid current GPS location is required.');
    var selected=weeklyPlanIdList_(data.selectedResIds || '');
    if(type==='Merchant outlets'&&selected.length!==1)throw new Error('Select exactly one restaurant ID before verifying the outlet location.');
    var plan=weeklyPlanObject_(rows[r]),targets=[];
    if(type==='Merchant outlets'){
      targets=(plan.brandOutletLocations||[]).filter(function(outlet){return selected.indexOf(String(outlet.id))>=0&&weeklyPlanLatitude_(outlet.latitude)!==null&&weeklyPlanLongitude_(outlet.longitude)!==null;});
      if(!targets.length&&plan.latitude!==null&&plan.longitude!==null)targets=[{latitude:plan.latitude,longitude:plan.longitude}];
    }
    var distances=targets.map(function(target){return weeklyPlanHaversineKm_(position,target)*1000;}),distance=distances.length?Math.min.apply(Math,distances):0;
    if(type==='Merchant outlets'&&distances.length&&distance>300)throw new Error('You must be within 300 m of a selected outlet.');
    data.distanceMetres=distance;
    sheet.getRange(rowNo,31).setValue(now);
    sheet.getRange(rowNo,32).setValue(weeklyPlanLatitude_(data.latitude));
    sheet.getRange(rowNo,33).setValue(weeklyPlanLongitude_(data.longitude));
    sheet.getRange(rowNo,34).setValue(weeklyPlanNumber_(data.distanceMetres));
    sheet.getRange(rowNo,47).setNumberFormat('@').setValue(JSON.stringify(selected));
    sheet.getRange(rowNo,48).setValue(type);
    sheet.getRange(rowNo,17).setValue(new Date());
    var arrivalMeta=beatActivityPlanMeta_(rows[r]);arrivalMeta.status='Arrived';arrivalMeta.latitude=position.latitude;arrivalMeta.longitude=position.longitude;arrivalMeta.accuracyMetres=data.accuracyMetres;beatActivityLog_('arrival_verified',user,arrivalMeta);
    return weeklyPlanExecutionResult_(sheet,rowNo,user,rows[r][1]);
  }
  throw new Error('This meeting plan is not available for your account.');
}

/** Marks the real meeting start. Audio permission is handled by the browser,
 * so an unavailable microphone never blocks manual field notes. */
function startWeeklyPlanMeeting(planId, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), now=weeklyPlanDateTime_(new Date());
  for (var r=1;r<rows.length;r++) {
    if (String(rows[r][0])!==String(planId) || String(rows[r][3]||'').toLowerCase()!==user.email) continue;
    var rowNo=r+1;
    var isCall=String(rows[r][42]||'Physical').toLowerCase()==='call';
    if (!isCall && !rows[r][30]) throw new Error('Confirm that you reached the merchant location before starting a physical meeting.');
    if (!rows[r][25]) sheet.getRange(rowNo,26).setValue(now);
    if (!rows[r][34]) sheet.getRange(rowNo,35).setValue(now);
    sheet.getRange(rowNo,16).setValue('Met');
    sheet.getRange(rowNo,17).setValue(new Date());
    var startMeta=beatActivityPlanMeta_(rows[r]);startMeta.status='Meeting started';startMeta.latitude=weeklyPlanLatitude_(rows[r][31]);startMeta.longitude=weeklyPlanLongitude_(rows[r][32]);beatActivityLog_('meeting_started',user,startMeta);
    return weeklyPlanExecutionResult_(sheet,rowNo,user,rows[r][1]);
  }
  throw new Error('This meeting plan is not available for your account.');
}

/** Saves the field session, optional browser recording and manual fallback.
 * Audio is deliberately capped to keep Apps Script requests reliable. */
function transcribeWeeklyPlanRecording(planId, recording, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), data=recording||{};
  if (!data.base64) throw new Error('Select a recording before starting transcription.');
  var raw=String(data.base64).replace(/^data:[^;]+;base64,/,'');
  if (raw.length>7500000) throw new Error('Recording must be 5 MB or smaller. You can still add meeting notes manually.');
  for (var r=1;r<rows.length;r++) {
    if (String(rows[r][0])!==String(planId) || String(rows[r][3]||'').toLowerCase()!==user.email) continue;
    var rowNo=r+1, current=rows[r], bytes=Utilities.base64Decode(raw);
    var name=weeklyPlanSafeFileName_(current[2]+' | '+current[6]+' | '+user.email)+weeklyPlanAudioExtension_(data.fileName,data.mimeType);
    var blob=Utilities.newBlob(bytes,String(data.mimeType||'audio/webm'),name);
    var file=weeklyPlanRecordingFolder_().createFile(blob), transcription=weeklyPlanTranscribeRecording_(blob);
    sheet.getRange(rowNo,17).setValue(new Date());
    sheet.getRange(rowNo,37).setValue(file.getUrl());
    sheet.getRange(rowNo,38).setValue(file.getId());
    if (transcription.text) sheet.getRange(rowNo,39).setValue(transcription.text);
    sheet.getRange(rowNo,42).setValue(transcription.status||'Recording uploaded');
    var meta=beatActivityPlanMeta_(current);meta.status=transcription.text?'Recording transcribed':'Recording uploaded';beatActivityLog_('recording_transcribed',user,meta);
    return weeklyPlanExecutionResult_(sheet,rowNo,user,current[1]);
  }
  throw new Error('This meeting plan is not available for your account.');
}

function saveWeeklyPlanMeetingSession(planId, payload, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), data=payload||{}, now=weeklyPlanDateTime_(new Date());
  for (var r=1;r<rows.length;r++) {
    if (String(rows[r][0])!==String(planId) || String(rows[r][3]||'').toLowerCase()!==user.email) continue;
    var rowNo=r+1, current=rows[r], recordingUrl=String(current[36]||''), recordingId=String(current[37]||''), transcription={text:'',status:''};
    var recording=data.recording||{};
    if (recording.base64) {
      var raw=String(recording.base64).replace(/^data:[^;]+;base64,/,'');
      if (raw.length>7500000) throw new Error('Recording is too large to upload. Save the manual notes and use a recording shorter than about 5 MB.');
      var bytes=Utilities.base64Decode(raw), name=weeklyPlanSafeFileName_(current[2]+' | '+current[6]+' | '+user.email)+weeklyPlanAudioExtension_(recording.fileName,recording.mimeType);
      var blob=Utilities.newBlob(bytes,String(recording.mimeType||'audio/webm'),name);
      var file=weeklyPlanRecordingFolder_().createFile(blob);
      recordingUrl=file.getUrl(); recordingId=file.getId();
      transcription=weeklyPlanTranscribeRecording_(blob);
    }
    var transcript=String(data.liveTranscript != null ? data.liveTranscript : (current[38]||''));
    if (!transcript.trim() && transcription.text) transcript=transcription.text;
    var manual=String(data.manualMeetingNotes != null ? data.manualMeetingNotes : (current[39]||''));
    var summary=String(data.meetingSummary || weeklyPlanSessionSummary_(current,transcript,manual,data));
    sheet.getRange(rowNo,16).setValue(String(data.status||'Met'));
    sheet.getRange(rowNo,17).setValue(new Date());
    if (!current[34]) sheet.getRange(rowNo,35).setValue(now);
    sheet.getRange(rowNo,36).setValue(now);
    sheet.getRange(rowNo,37).setValue(recordingUrl);
    sheet.getRange(rowNo,38).setValue(recordingId);
    sheet.getRange(rowNo,39).setValue(transcript);
    sheet.getRange(rowNo,40).setValue(manual);
    sheet.getRange(rowNo,41).setValue(summary);
    sheet.getRange(rowNo,42).setValue(recording.base64 ? (transcription.status || 'Recording uploaded') : (transcript ? 'Transcript captured' : (manual ? 'Manual notes captured' : 'No notes captured')));
    if (data.followUpDate != null) sheet.getRange(rowNo,15).setValue(weeklyPlanDate_(data.followUpDate));
    if (data.merchantCommitment != null) sheet.getRange(rowNo,23).setValue(String(data.merchantCommitment));
    if (data.kamCommitment != null) sheet.getRange(rowNo,59).setValue(String(data.kamCommitment));
    if (data.mxCommitment != null) {
      sheet.getRange(rowNo,60).setValue(String(data.mxCommitment));
      sheet.getRange(rowNo,23).setValue(String(data.mxCommitment));
    }
    if (data.commitmentOwner != null) sheet.getRange(rowNo,24).setValue(String(data.commitmentOwner));
    if (data.commitmentDueDate != null) {
      var oldDue=weeklyPlanDate_(current[24]), newDue=weeklyPlanDate_(data.commitmentDueDate);
      sheet.getRange(rowNo,25).setValue(newDue);
      if (newDue !== oldDue) sheet.getRange(rowNo,44).setValue('');
      if (newDue) ensureWeeklyPlanReminderTrigger_();
    }
    if (data.meetingType != null) sheet.getRange(rowNo,43).setValue(weeklyPlanMeetingType_(data.meetingType));
    weeklyPlanCaptureCompletionMetrics_(sheet,rowNo,current,user,clusterOverride);
    var doneMeta=beatActivityPlanMeta_(current);doneMeta.status=String(data.status||'Met');beatActivityLog_('meeting_completed',user,doneMeta);
    return weeklyPlanExecutionResult_(sheet,rowNo,user,current[1]);
  }
  throw new Error('This meeting plan is not available for your account.');
}

function weeklyPlanExecutionResult_(sheet,rowNo,user,weekStart) {
  var row=sheet.getRange(rowNo,1,1,WEEKLY_PLAN_HEADERS_.length).getValues()[0];
  var dates=beatPilotWindow_(user,weekStart),plans=weeklyPlanRows_(user.email,weekStart),team=weeklyPlanTeamReview_(user,weekStart);
  ahmedabadWritePlanSnapshot_(user,weekStart,dates,plans,team);
  return {ok:true,plan:weeklyPlanObject_(row),plans:plans,team:team};
}

/** Selects whether a meeting is a field visit or a call. A call intentionally
 * bypasses the field-arrival check while retaining notes, commitments and
 * recordings in the exact same tracker row. */
function setWeeklyPlanMeetingType(planId, meetingType, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), type=weeklyPlanMeetingType_(meetingType);
  if (!type) throw new Error('Choose On-site, Virtual or Call.');
  for (var r=1;r<rows.length;r++) {
    if (String(rows[r][0])!==String(planId) || String(rows[r][3]||'').toLowerCase()!==user.email) continue;
    // The selected execution mode may differ from the planning suggestion.
    // Do not block a KAM at the merchant; updated workload is visible in UI.
    if(weeklyPlanMeetingType_(rows[r][42])==='Virtual'&&type!=='Virtual'&&String(rows[r][29]||'')){
      var meetActor=beatVirtualCalendarActor_(user),meetOrganiser=weeklyPlanLower_(rows[r][55]||user.email);
      if(meetActor!==meetOrganiser)throw new Error('Only the Meet organiser ('+meetOrganiser+') can cancel this invitation.');
      var cancelledEvent=CalendarApp.getDefaultCalendar().getEventById(String(rows[r][29]||''));
      if(!cancelledEvent)throw new Error('The Calendar invitation was not found on the organiser’s calendar.');
      cancelledEvent.deleteEvent();
      sheet.getRange(r+1,30).setValue('');sheet.getRange(r+1,52,1,5).clearContent();
    }
    sheet.getRange(r+1,43).setValue(type);
    sheet.getRange(r+1,17).setValue(new Date());
    var modeMeta=beatActivityPlanMeta_(rows[r]);modeMeta.meetingType=type;beatActivityLog_('meeting_mode_changed',user,modeMeta);
    // Mode selection is a tiny preference update. Returning/rebuilding the
    // entire rolling plan, hierarchy and JSON snapshot made a simple button
    // take tens of seconds. The client already updates optimistically and only
    // needs the saved row as confirmation.
    return {ok:true,plan:weeklyPlanObject_(sheet.getRange(r+1,1,1,WEEKLY_PLAN_HEADERS_.length).getValues()[0])};
  }
  throw new Error('This meeting plan is not available for your account.');
}

/** A light hourly trigger sends one email on (or after) a due date. It is
 * de-duplicated per commitment, and editing the due date re-arms the reminder. */
function ensureWeeklyPlanReminderTrigger_() {
  var exists=ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction()==='weeklyPlanCommitmentReminderTick'; });
  if (!exists) ScriptApp.newTrigger('weeklyPlanCommitmentReminderTick').timeBased().everyHours(1).create();
}
function weeklyPlanCommitmentReminderTick() {
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  if (!sheet || sheet.getLastRow()<2) return;
  var rows=sheet.getDataRange().getValues(), today=weeklyPlanDate_(new Date());
  for (var r=1;r<rows.length;r++) {
    var due=weeklyPlanDate_(rows[r][24]), recipient=String(rows[r][3]||'').trim(), commitment=String(rows[r][22]||'').trim();
    if (!recipient || !commitment || !due || due>today || String(rows[r][43]||'').trim()) continue;
    try {
      var restaurant=String(rows[r][6]||'Merchant'), owner=String(rows[r][23]||'you');
      MailApp.sendEmail({to:recipient,subject:'Brahmastra follow-up · '+restaurant,body:'Reminder: the commitment due today for '+restaurant+' is: '+commitment+'\nOwner: '+owner+'\nPlease update the meeting plan after following up.',htmlBody:'<p><b>Brahmastra follow-up</b></p><p>The commitment due today for <b>'+weeklyPlanHtml_(restaurant)+'</b> is:</p><p>'+weeklyPlanHtml_(commitment)+'</p><p><b>Owner:</b> '+weeklyPlanHtml_(owner)+'</p><p>Please update the meeting plan after following up.</p>'});
      sheet.getRange(r+1,44).setValue(new Date());
    } catch(err) { Logger.log('Weekly plan reminder could not be sent: '+err); }
  }
}
function weeklyPlanHtml_(value) { return String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }
function weeklyPlanRecordingFolder_() {
  var props=PropertiesService.getScriptProperties(), id=String(props.getProperty(WEEKLY_PLAN_RECORDING_FOLDER_PROP_)||''), folder;
  try { folder=id?DriveApp.getFolderById(id):null; } catch(ignore) { folder=null; }
  if (!folder) { folder=DriveApp.createFolder('Brahmastra — Meeting Recordings'); props.setProperty(WEEKLY_PLAN_RECORDING_FOLDER_PROP_,folder.getId()); }
  return folder;
}
function weeklyPlanSafeFileName_(value) { return String(value||'meeting').replace(/[\\/:*?"<>|]/g,'-').slice(0,160); }
function weeklyPlanAudioExtension_(fileName, mimeType) {
  var match=String(fileName||'').match(/(\.[a-z0-9]{2,5})$/i);
  if (match) return match[1].toLowerCase();
  var type=String(mimeType||'').toLowerCase();
  if (type.indexOf('mpeg')>=0 || type.indexOf('mp3')>=0) return '.mp3';
  if (type.indexOf('wav')>=0) return '.wav';
  if (type.indexOf('ogg')>=0) return '.ogg';
  if (type.indexOf('mp4')>=0 || type.indexOf('m4a')>=0) return '.m4a';
  if (type.indexOf('aac')>=0) return '.aac';
  return '.webm';
}
function weeklyPlanDialogueAiConfig_() {
  var raw=String(PropertiesService.getScriptProperties().getProperty(WEEKLY_PLAN_GLOBAL_AI_PROP_)||'').trim();
  if (raw) {
    try {
      var globalCfg=JSON.parse(raw);
      if (globalCfg && globalCfg.endpointUrl) return globalCfg;
    } catch(ignoreGlobalConfig) {}
  }
  return weeklyPlanAiConfig_();
}
function weeklyPlanDialogueText_(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.trim();
  return String(data.reply || data.output || data.text || data.generated_text || data.response || (data.data && (data.data.text || data.data.output)) || '').trim();
}
function weeklyPlanHeuristicDialogue_(rawText) {
  var raw=String(rawText||'').replace(/\s+/g,' ').trim();
  if (!raw) return '';
  if (/^(KAM|Merchant)\s*:/im.test(raw)) return raw.replace(/\s+(?=(?:KAM|Merchant)\s*:)/gi,'\n');
  var turns=raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g)||[raw], output=[],lastQuestion=false;
  turns.forEach(function(value,index){
    var text=String(value||'').trim();if(!text)return;
    var shortReply=/^(yes|yeah|yep|no|okay|ok|sure|good|fine|right|correct|tell me|go ahead|please continue)\b/i.test(text);
    var merchantIntro=/\b(i am|i'm)\b.{0,45}\b(owner|manager|proprietor|partner)\b/i.test(text);
    var asksQuestion=/\?$|\b(can we|can you|could you|would you|what|how|why|when|where|shall we|do you)\b/i.test(text);
    var speaker=(merchantIntro||shortReply||lastQuestion)?'Merchant':'KAM';
    if(index===0&&!merchantIntro)speaker='KAM';
    if(asksQuestion&&!shortReply&&!merchantIntro)speaker='KAM';
    var previous=output[output.length-1];
    if(previous&&previous.speaker===speaker)previous.text+=' '+text;else output.push({speaker:speaker,text:text});
    lastQuestion=asksQuestion;
  });
  return output.map(function(turn){return turn.speaker+': '+turn.text;}).join('\n');
}
function weeklyPlanFormatDialogueTranscript_(rawText) {
  var raw=String(rawText||'').trim();
  if (!raw) return {text:'',formatted:false};
  try {
    var cfg=weeklyPlanDialogueAiConfig_();
    if (!cfg || !cfg.endpointUrl) return {text:weeklyPlanHeuristicDialogue_(raw),formatted:true,method:'best-effort'};
    var prompt=[
      'Convert this field-meeting transcription into a readable two-speaker dialogue.',
      'Use only these labels: KAM: and Merchant:.',
      'Preserve the meaning and every material statement. Do not summarise, invent facts, commitments or numbers.',
      'Break the conversation into short natural turns. Clean filler and obvious speech-to-text punctuation errors only.',
      'Speaker assignment is best-effort. If the source does not identify a speaker, infer conservatively from questions and answers.',
      'Return dialogue only, one turn per line, with no title, markdown or commentary.',
      '',
      'RAW TRANSCRIPT:',
      raw
    ].join('\n');
    var request=cfg.provider==='colab-qwen' ? {task:'speaker_dialogue_transcript',message:prompt,context:{}} : {task:'speaker_dialogue_transcript',inputs:prompt};
    var data=weeklyPlanAiRequest_(cfg,request), text=weeklyPlanDialogueText_(data)
      .replace(/^```(?:text)?\s*/i,'').replace(/\s*```$/,'').trim();
    var labelled=text.split(/\r?\n/).filter(function(line){return /^(KAM|Merchant)\s*:/i.test(String(line).trim());}).join('\n').trim();
    return labelled ? {text:labelled,formatted:true,method:'model'} : {text:weeklyPlanHeuristicDialogue_(raw),formatted:true,method:'best-effort'};
  } catch(err) {
    Logger.log('Weekly plan dialogue formatting failed: '+err);
    return {text:weeklyPlanHeuristicDialogue_(raw),formatted:true,method:'best-effort'};
  }
}
function weeklyPlanTranscribeRecording_(blob) {
  var apiKey=String(PropertiesService.getScriptProperties().getProperty(WEEKLY_PLAN_OPENAI_KEY_PROP_)||'').trim();
  if (!apiKey) return {text:'',status:'Recording uploaded; AI transcription is not configured.'};
  try {
    var response=UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions',{
      method:'post',
      headers:{Authorization:'Bearer '+apiKey},
      payload:{file:blob,model:'gpt-4o-mini-transcribe',response_format:'json',language:'en'},
      muteHttpExceptions:true
    });
    var parsed={};
    try { parsed=JSON.parse(response.getContentText()||'{}'); } catch(ignore) {}
    var text=String(parsed.text||'').trim();
    if (response.getResponseCode()>=200 && response.getResponseCode()<300 && text) {
      var dialogue=weeklyPlanFormatDialogueTranscript_(text);
      return {text:dialogue.text,status:dialogue.method==='model'?'KAM / Merchant dialogue generated from uploaded recording':'Best-effort KAM / Merchant dialogue generated; review the editable speaker labels'};
    }
    return {text:'',status:'Recording uploaded; AI transcript was unavailable. Add notes manually if needed.'};
  } catch(err) {
    Logger.log('Weekly plan recording transcription failed: '+err);
    return {text:'',status:'Recording uploaded; AI transcript was unavailable. Add notes manually if needed.'};
  }
}
function formatWeeklyPlanTranscript(planId, rawText, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues();
  for(var r=1;r<rows.length;r++){
    if(String(rows[r][0])!==String(planId)||String(rows[r][3]||'').toLowerCase()!==user.email)continue;
    var source=String(rawText||rows[r][38]||'').trim();
    if(!source)throw new Error('No transcript is available to format.');
    var dialogue=weeklyPlanFormatDialogueTranscript_(source),rowNo=r+1;
    sheet.getRange(rowNo,39).setValue(dialogue.text);
    sheet.getRange(rowNo,42).setValue(dialogue.method==='model'?'KAM / Merchant dialogue generated':'Best-effort speaker dialogue generated; review labels');
    sheet.getRange(rowNo,17).setValue(new Date());
    return weeklyPlanExecutionResult_(sheet,rowNo,user,rows[r][1]);
  }
  throw new Error('This meeting plan is not available for your account.');
}
function weeklyPlanSessionSummary_(row, transcript, manual, data) {
  var parts=['Meeting completed for '+String(row[6]||'merchant')+'.'];
  if (manual) parts.push('KAM notes: '+manual.slice(0,700));
  else if (transcript) parts.push('Live transcript captured ('+transcript.length+' characters).');
  if (data.kamCommitment) parts.push('KAM commitment: '+String(data.kamCommitment));
  if (data.mxCommitment || data.merchantCommitment) parts.push('MX commitment: '+String(data.mxCommitment || data.merchantCommitment));
  if (data.followUpDate) parts.push('Follow-up: '+weeklyPlanDate_(data.followUpDate)+'.');
  return parts.join(' ');
}

/** Move an unfinished call into the next available capacity slot, preferring
 * the same city. This is the practical recovery behaviour of a beat plan. */
function rescheduleWeeklyPlan(planId, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), target=null, targetNo=-1;
  for(var r=1;r<rows.length;r++) if(String(rows[r][0])===String(planId) && String(rows[r][3]||'').toLowerCase()===user.email){target=rows[r];targetNo=r+1;break;}
  if(!target) throw new Error('This meeting plan is not available for your account.');
  var monday=weeklyPlanDate_(target[1]), today=weeklyPlanDate_(new Date()), pick=null,capacity=weeklyPlanDailyCapacity_();
  for(var d=1;d<=42;d++){
    var date=weeklyPlanRepeatDay_(today,d),weekday=new Date(date+'T12:00:00Z').getUTCDay();
    if(weekday===0||weekday===6)continue;
    if(weeklyPlanDayLoad_(rows.slice(1),user.email,date,planId)+weeklyPlanRowUnits_(target)<=capacity){pick={date:date,time:''};break;}
  }
  if(!pick)throw new Error('No free weekday capacity in the next six weeks.');
  sheet.getRange(targetNo,2).setValue(weeklyPlanMonday_(pick.date));
  sheet.getRange(targetNo,3).setValue(pick.date); sheet.getRange(targetNo,10).setValue(''); sheet.getRange(targetNo,16).setValue('Follow-up'); sheet.getRange(targetNo,17).setValue(new Date());
  return {ok:true, movedTo:pick, plans:weeklyPlanRows_(user.email,monday), team:weeklyPlanTeamReview_(user,monday)};
}

function weeklyPlanCascadeReschedule_(sheet,rows,targetNo,target,date,time,user){
  var leaves=beatPilotPreferences_(user).leaveDates||[],affected=[],ids={},rank={P0:0,P1:1,P2:2},originalDate=weeklyPlanDate_(target[2]),reflowStart=originalDate<date?originalDate:date,capacity=weeklyPlanDailyCapacity_(),maxOnsite=weeklyPlanMaxOnsite_(),onsiteUnits=weeklyPlanVisitUnits_('Physical'),maxLeg=Number(beatLogicValue_('route_max_leg_km'))||6;
  // Rebuild from the earlier of the old/new dates. Starting only at the new
  // date left the old day frozen and progressively hollowed out later days.
  rows.slice(1).forEach(function(r,i){if(i+2===targetNo)return;if(weeklyPlanLower_(r[3])===weeklyPlanLower_(user.email)&&weeklyPlanDate_(r[2])>=reflowStart&&beatPilotMovable_(r)){affected.push({row:r.slice(),rowNo:i+2,converted:false});ids[String(r[0])]=true;}});
  ids[String(target[0])]=true;
  var retained=rows.slice(1).filter(function(r){return !ids[String(r[0])];}),calendar=retained.slice(),office=weeklyPlanRouteStart_({latitude:user.officeLatitude,longitude:user.officeLongitude});
  if(!office)throw new Error('Office latitude/longitude is missing for this KAM in Master of Ahmedabad. Route reflow needs an office starting point.');
  function stats_(d){return calendar.reduce(function(s,r){if(weeklyPlanLower_(r[3])!==weeklyPlanLower_(user.email)||weeklyPlanDate_(r[2])!==d||/cancelled|canceled/i.test(String(r[15])))return s;var mode=weeklyPlanRowMode_(r);s.units+=weeklyPlanRowUnits_(r);if(mode==='Physical')s.onsite++;else s.calls++;return s;},{units:0,onsite:0,calls:0});}
  function prioritySort_(a,b){var ar=Object.prototype.hasOwnProperty.call(rank,a.row[8])?rank[a.row[8]]:1,br=Object.prototype.hasOwnProperty.call(rank,b.row[8])?rank[b.row[8]]:1;return ar-br||weeklyPlanNumber_(b.row[19])-weeklyPlanNumber_(a.row[19])||String(a.row[6]).localeCompare(String(b.row[6]));}
  function candidate_(item){return {item:item,restaurant:String(item.row[6]||''),city:String(item.row[5]||''),priority:String(item.row[8]||'P1'),score:weeklyPlanNumber_(item.row[19]),latitude:weeklyPlanLatitude_(item.row[27]),longitude:weeklyPlanLongitude_(item.row[28])};}
  function stage_(item,d){item.row[2]=d;item.row[9]='';item.row[16]=new Date();calendar.push(item.row);staged.push({row:item.row,rowNo:item.rowNo,date:d,time:'',convertedToCall:!!item.converted});}
  var targetCopy=target.slice();targetCopy[2]=date;targetCopy[9]='';targetCopy[15]='Follow-up';targetCopy[16]=new Date();
  var targetStats=stats_(date),targetMode=weeklyPlanRowMode_(targetCopy);if(targetMode==='Physical'&&(weeklyPlanLatitude_(targetCopy[27])===null||weeklyPlanLongitude_(targetCopy[28])===null))throw new Error('This on-site brand has no meeting-point coordinates. Save its meeting point first or switch it to Call.');if(targetStats.units+weeklyPlanRowUnits_(targetCopy)>capacity||(targetMode==='Physical'&&targetStats.onsite>=maxOnsite))throw new Error('Protected/started work already fills the selected day capacity. Choose another date.');
  var staged=[{row:targetCopy,rowNo:targetNo,date:date,time:'',convertedToCall:false}];calendar.push(targetCopy);
  var workdays=beatPilotDays_(reflowStart,leaves,90),visibleEnd=weeklyPlanRepeatDay_(reflowStart,7),visibleDays=workdays.filter(function(d){return d<=visibleEnd;});
  affected.forEach(function(item){if(weeklyPlanRowMode_(item.row)==='Physical'&&(weeklyPlanLatitude_(item.row[27])===null||weeklyPlanLongitude_(item.row[28])===null)){item.row[42]='';item.row[57]='Call';item.converted=true;}});
  // Keep the visible week feasible first. If it contains more onsite work than
  // its protected capacity, demote the lowest priority/score movable visits
  // to calls. The explicitly rescheduled brand is never demoted.
  var onsiteCapacity=visibleDays.reduce(function(total,d){var s=stats_(d);return total+Math.max(0,Math.min(maxOnsite-s.onsite,Math.floor((capacity-s.units)/onsiteUnits)));},0);
  var physical=affected.filter(function(item){return weeklyPlanRowMode_(item.row)==='Physical';});
  if(physical.length>onsiteCapacity){physical.sort(function(a,b){return prioritySort_(b,a);});physical.slice(0,physical.length-onsiteCapacity).forEach(function(item){item.row[42]='';item.row[57]='Call';item.converted=true;});}
  var remaining=affected.slice();
  for(var di=0;di<workdays.length&&remaining.length;di++){
    var d=workdays[di],s=stats_(d),siteLimit=Math.max(0,Math.min(maxOnsite-s.onsite,Math.floor((capacity-s.units)/onsiteUnits))),sitePool=remaining.filter(function(item){return weeklyPlanRowMode_(item.row)==='Physical';}),selected=[],visibleLeft=Math.max(1,visibleDays.filter(function(x){return x>=d;}).length),balancedSiteTarget=Math.min(siteLimit,Math.ceil(sitePool.length/visibleLeft));
    if(siteLimit&&sitePool.length){
      var siteCandidates=sitePool.map(candidate_);
      if(d===date&&targetMode==='Physical'){
        var anchor=candidate_({row:targetCopy,rowNo:targetNo}),near=siteCandidates.filter(function(c){var km=weeklyPlanDistanceKm_(anchor,c);return km!==null&&km<=maxLeg;});
        near.sort(function(a,b){var da=weeklyPlanDistanceKm_(anchor,a),db=weeklyPlanDistanceKm_(anchor,b);return da-db||prioritySort_(a.item,b.item);});selected=near.slice(0,balancedSiteTarget);
      } else selected=weeklyPlanNearbySites_(siteCandidates,office,balancedSiteTarget);
      // Every item here is already metric-qualified. If a very tight geo
      // pocket is sparse, fill the balanced daily target with the nearest
      // remaining qualified brands instead of collapsing the day to one visit.
      if(selected.length<balancedSiteTarget){
        var chosen={};selected.forEach(function(c){chosen[String(c.item.row[0])]=true;});
        var cursor=selected.length?selected[selected.length-1]:{latitude:office.latitude,longitude:office.longitude};
        siteCandidates.filter(function(c){return !chosen[String(c.item.row[0])];}).sort(function(a,b){var da=weeklyPlanDistanceKm_(cursor,a),db=weeklyPlanDistanceKm_(cursor,b);return (da===null?9999:da)-(db===null?9999:db)||prioritySort_(a.item,b.item);}).slice(0,balancedSiteTarget-selected.length).forEach(function(c){selected.push(c);});
      }
      selected.forEach(function(c){var item=c.item;stage_(item,d);remaining.splice(remaining.indexOf(item),1);});
    }
    s=stats_(d);var calls=remaining.filter(function(item){return weeklyPlanRowMode_(item.row)!=='Physical';}).sort(prioritySort_),futureVisible=Math.max(1,visibleDays.filter(function(x){return x>=d;}).length),quota=Math.ceil(calls.length/futureVisible);
    for(var ci=0;ci<calls.length&&ci<quota&&s.units+weeklyPlanRowUnits_(calls[ci].row)<=capacity;ci++){var callItem=calls[ci];stage_(callItem,d);remaining.splice(remaining.indexOf(callItem),1);s=stats_(d);}
  }
  if(remaining.length)throw new Error('The route could not be rebalanced within the next 90 working days. Nothing was changed.');
  var cursor={};staged.forEach(function(x){x.row[1]=weeklyPlanMonday_(x.date);cursor[x.date]=(cursor[x.date]||0)+1;x.row[56]=cursor[x.date];sheet.getRange(x.rowNo,1,1,WEEKLY_PLAN_HEADERS_.length).setValues([x.row]);});weeklyPlanReorderDayRoutes_(sheet,user,Object.keys(cursor));
  return staged.map(function(x){return {id:String(x.row[0]),date:x.date,mode:weeklyPlanRowMode_(x.row),convertedToCall:!!x.convertedToCall};});
}

/** Lets the assigned KAM choose a new valid meeting slot. Team views remain
 * read-only, but can follow the rescheduled status immediately. */
function rescheduleWeeklyPlanAt(planId, meetingDate, meetingTime, viewer, clusterOverride, viewAsKam, feedback) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), target=null, targetNo=-1;
  for(var r=1;r<rows.length;r++) if(String(rows[r][0])===String(planId) && String(rows[r][3]||'').toLowerCase()===String(user.email||'').toLowerCase()){target=rows[r];targetNo=r+1;break;}
  if(!target) throw new Error('Only the assigned KAM can reschedule this meeting.');
  var allowedReasons=['Merchant unavailable','Merchant requested another time','Wrong outlet or location','Travel or traffic delay','Previous meeting overran','KAM unavailable','Need more data or preparation','Meeting no longer relevant','Other'];
  if(!feedback || allowedReasons.indexOf(String(feedback.reason))<0)throw new Error('Select a reason for rescheduling.');
  if(feedback.reason==='Other' && !String(feedback.comment||'').trim())throw new Error('Please explain the reason.');
  var date=weeklyPlanDate_(meetingDate), time='';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid date.');
  if(date<weeklyPlanDate_(new Date()))throw new Error('Choose today or a future date.');
  var weekday=new Date(date+'T12:00:00Z').getUTCDay();if(weekday===0||weekday===6)throw new Error('Choose a working weekday for an automatic route.');
  if(beatPilotPreferences_(user).leaveDates.indexOf(date)>=0)throw new Error('This is a leave day. Choose another date.');
  var monday=weeklyPlanMonday_(date);
  weeklyPlanAppendFeedback_(['Timestamp','Actor','KAM','Cluster','Feature','Plan ID','Rating','Reason','Comment','From date','From time','To date','To time'],[new Date(),String(viewer||user.email),user.email,user.cluster||clusterOverride,'Reschedule',String(planId),'',feedback.reason,String(feedback.comment||'').slice(0,1500),weeklyPlanDate_(target[2]),weeklyPlanTime_(target[9]),date,time],'Reschedule History');
  var cascaded=weeklyPlanCascadeReschedule_(sheet,rows,targetNo,target,date,time,user);
  var dates=beatPilotWindow_(user),last=cascaded.map(function(x){return x.date;}).sort().pop();if(last&&dates.indexOf(last)<0)dates.push(last);dates.sort();
  var fresh=sheet.getDataRange().getValues().slice(1),plans=fresh.filter(function(row){return weeklyPlanLower_(row[3])===weeklyPlanLower_(user.email)&&weeklyPlanClusterMatch_(row[4],user.cluster)&&dates.indexOf(weeklyPlanDate_(row[2]))>=0;}).map(weeklyPlanObject_).sort(function(a,b){return a.meetingDate.localeCompare(b.meetingDate)||(a.routeOrder||0)-(b.routeOrder||0);}),team=null;
  ahmedabadWritePlanSnapshot_(user,monday,dates,plans,team);
  var moveMeta=beatActivityPlanMeta_(target);moveMeta.status='Rescheduled';moveMeta.meetingDate=date;beatActivityLog_('meeting_rescheduled',user,moveMeta);
  return {ok:true,plan:weeklyPlanObject_(sheet.getRange(targetNo,1,1,WEEKLY_PLAN_HEADERS_.length).getValues()[0]),dates:dates,plans:plans,team:team,cascaded:cascaded};
}

function weeklyPlanAppendFeedback_(headers,row,name) {
  var lock=LockService.getScriptLock();lock.waitLock(15000);
  try{var book=weeklyPlanBook_(),s=book.getSheetByName(name)||book.insertSheet(name);if(!s.getLastRow()){s.appendRow(headers);s.setFrozenRows(1);}
    // User text is stored literally, never interpreted as a Sheet formula.
    s.appendRow(row.map(function(v){return typeof v==='string'&&/^[=+@-]/.test(v)?"'"+v:v;}));
  }finally{lock.releaseLock();}
}
function saveBrahmastraFeatureFeedback(payload,viewer,clusterOverride,viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),p=payload||{};
  var features=['Targets','Portfolio','Ongoing Drive','Leaderboard','War Room','X-Ray Vision','Beat Plan','Settings','Merchant brief','AI prep','Merchant deck','Day route','Weekly route','Lead list','Portfolio analysis'];
  if(features.indexOf(p.feature)<0 || ['up','down'].indexOf(p.rating)<0)throw new Error('Choose a valid feature and rating.');
  var planId=String(p.planId||'');
  if(planId){var own=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_).getDataRange().getValues().some(function(r){return String(r[0])===planId && String(r[3]).toLowerCase()===String(user.email).toLowerCase();});if(!own)throw new Error('Meeting not available in this KAM context.');}
  weeklyPlanAppendFeedback_(['Timestamp','Actor','KAM','Cluster','Feature','Plan ID','Rating','Reason','Comment'],[new Date(),String(viewer||user.email),user.email,user.cluster||clusterOverride,p.feature,planId,p.rating,String(p.reason||'').slice(0,120),String(p.comment||'').slice(0,1500)],'Feature Feedback');
  return {ok:true};
}

/** Sends a single actionable reminder for the selected KAM's overdue calls.
 * This is intentionally available only to ZH/TL, CEO and Core views. */
function notifyWeeklyPlanDueMeetings(kamEmail, weekStart, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);
  if(weeklyPlanRoleType_(user)==='kam') throw new Error('Team reminders are available to ZH/TL and CEO views.');
  var email=weeklyPlanLower_(kamEmail), plans=weeklyPlanScopedRows_(user,weekStart).filter(function(p){return weeklyPlanLower_(p.kamEmail)===email;});
  var today=weeklyPlanDate_(new Date()), due=plans.filter(function(p){return p.meetingDate<=today && ['met','closed'].indexOf(weeklyPlanLower_(p.status))<0;});
  if(!due.length)return {ok:true,count:0};
  var body='These Beat Plan meetings need an update:\n\n'+due.map(function(p){return '• '+p.restaurant+' · '+p.meetingDate+' '+p.meetingTime+' · '+p.status;}).join('\n')+'\n\nPlease update the outcome or reschedule the meeting in Brahmastra.';
  MailApp.sendEmail(email,'Brahmastra Beat Plan · '+due.length+' due meeting'+(due.length===1?'':'s'),body);
  return {ok:true,count:due.length};
}

/** Carries every unfinished meeting from a chosen day into the next available
 * weekday slots. Sunday is deliberately skipped: it remains an opt-in manual
 * meeting day. City continuity is preferred within each target day. */
function carryWeeklyPlanPending(planDate, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer, clusterOverride, viewAsKam), sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet.getDataRange().getValues(), sourceDate=weeklyPlanDate_(planDate);
  var pending=[],leaveDates=beatPilotPreferences_(user).leaveDates;
  for (var r=1;r<rows.length;r++) {
    var status=String(rows[r][15]||'Planned').toLowerCase();
    if(status!=='closed' && /no.show|reschedule/i.test(String(rows[r][21]||''))) status='follow-up';
    if (String(rows[r][3]||'').toLowerCase()===user.email && weeklyPlanDate_(rows[r][2])===sourceDate && ['planned','follow-up','no-show','reschedule requested'].indexOf(status)>=0 && beatPilotMovable_(rows[r])) pending.push({row:rows[r],rowNo:r+1});
  }
  if (!pending.length) return {ok:true,moved:0,plans:weeklyPlanRows_(user.email,weeklyPlanMonday_(sourceDate)),team:weeklyPlanTeamReview_(user,weeklyPlanMonday_(sourceDate))};
  pending.sort(function(a,b){
    var rank={P0:0,P1:1,P2:2};
    var priorityRank=function(item){ var value=rank[String(item.row[8]||'P1')]; return value == null ? 1 : value; };
    return priorityRank(a)-priorityRank(b) || weeklyPlanNumber_(b.row[19])-weeklyPlanNumber_(a.row[19]);
  });
  var occupied=rows.slice(1).filter(function(row){ return String(row[3]||'').toLowerCase()===user.email && weeklyPlanDate_(row[2])>sourceDate; });
  var candidates=[];
  var firstOffset=Math.max(1,Math.floor((new Date(weeklyPlanDate_(new Date())+'T12:00:00')-new Date(sourceDate+'T12:00:00'))/86400000));
  beatPilotDays_(weeklyPlanRepeatDay_(sourceDate,firstOffset),leaveDates,60).forEach(function(date){
    candidates.push({date:date,time:'',load:weeklyPlanDayLoad_(occupied,user.email,date)});
  });
  var capacity=weeklyPlanDailyCapacity_(),picks=pending.map(function(item){
    var units=weeklyPlanRowUnits_(item.row), pick=candidates.filter(function(day){return day.load+units<=capacity;})[0];
    if(!pick)throw new Error('Not enough capacity in the next 60 working days; no meetings were moved.');
    pick.load+=units; return {date:pick.date,time:''};
  });
  var moved=[];
  pending.forEach(function(item,index){
    var pick=picks[index];
    sheet.getRange(item.rowNo,2).setValue(weeklyPlanMonday_(pick.date));
    sheet.getRange(item.rowNo,3).setValue(pick.date);
    sheet.getRange(item.rowNo,10).setValue(pick.time);
    sheet.getRange(item.rowNo,16).setValue('Follow-up');
    sheet.getRange(item.rowNo,17).setValue(new Date());
    moved.push({id:String(item.row[0]),date:pick.date,time:pick.time,restaurant:String(item.row[6]||'Merchant')});
  });
  moved.forEach(function(x){ try { syncWeeklyPlanCalendar(x.id,viewer,clusterOverride,viewAsKam); } catch(ignoreCalendar) {} });
  var monday=weeklyPlanMonday_(sourceDate);
  return {ok:true,moved:moved.length,assignments:moved,plans:weeklyPlanRows_(user.email,monday),team:weeklyPlanTeamReview_(user,monday)};
}

/** Automatically reflows only meetings from days that are already over.
 * Sunday is never selected as a carry-forward day; a Sunday meeting exists
 * only when somebody has explicitly scheduled it. */
function weeklyPlanAutoCarryPastDue_(user, weekStart, clusterOverride, viewAsKam) {
  var monday=weeklyPlanMonday_(weekStart), today=weeklyPlanDate_(new Date());
  if (monday > today) return 0;
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_), rows=sheet.getDataRange().getValues(), dates={};
  for (var r=1;r<rows.length;r++) {
    var date=weeklyPlanDate_(rows[r][2]), status=String(rows[r][15]||'Planned').toLowerCase();
    if(status!=='closed' && /no.show|reschedule/i.test(String(rows[r][21]||''))) status='follow-up';
    if (String(rows[r][3]||'').toLowerCase()!==String(user.email||'').toLowerCase()) continue;
    if (!date || date>=today || ['planned','follow-up','no-show','reschedule requested'].indexOf(status)<0) continue;
    dates[date]=true;
  }
  var moved=0;
  Object.keys(dates).sort().forEach(function(date){
    try { moved += Number((carryWeeklyPlanPending(date,user.email,clusterOverride,viewAsKam)||{}).moved||0); } catch(ignore) {}
  });
  return moved;
}

function deleteWeeklyPlan(planId, viewer, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  var sheet = weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows = sheet.getDataRange().getValues();
  for (var r=1; r<rows.length; r++) {
    if (String(rows[r][0]) === String(planId) && String(rows[r][3]).toLowerCase() === user.email) {
      // Remove the matching personal calendar block as well. Calendar cleanup
      // is intentionally best-effort so a missing permission never prevents a
      // KAM from deleting a meeting plan.
      try {
        var calendarEventId = String(rows[r][29] || '');
        if (calendarEventId) {
          var calendar = CalendarApp.getDefaultCalendar();
          var event = calendar.getEventById(calendarEventId);
          if (event) event.deleteEvent();
        }
      } catch(ignoreCalendarDelete) {}
      var weekStart = rows[r][1]; sheet.deleteRow(r+1);
      // The Drive JSON is only a derived snapshot. Remove the stale snapshot
      // before returning live rows so a refresh cannot resurrect this card.
      ahmedabadInvalidateJsonCache_('schedule',user.email);
      var livePlans=weeklyPlanRows_(user.email,weekStart);
      ahmedabadWritePlanSnapshot_(user,weekStart,beatPilotWindow_(user,weekStart),livePlans,weeklyPlanTeamReview_(user,weekStart));
      return {ok:true, plans:livePlans};
    }
  }
  throw new Error('This meeting plan is not available for your account.');
}

/**
 * Run this once from the Apps Script editor after adding Calendar scope to the
 * manifest. It deliberately touches the default calendar to trigger Google's
 * consent flow before KAMs use Sync my calendar in the web app.
 */
function AuthoriseBrahmastraWeeklyCalendar() {
  var calendar=CalendarApp.getDefaultCalendar();
  return {ok:true,calendarId:calendar.getId(),timeZone:Session.getScriptTimeZone(),message:'Calendar permission is ready. Deploy as User accessing the web app; each user authorises their own Calendar.'};
}

/**
 * Creates or updates the logged-in KAM's own Google Calendar event. This is
 * deliberately best-effort: an unavailable calendar permission must never
 * block a saved beat plan. Deploy the web app as "user accessing the web app"
 * so events land in each KAM's own calendar rather than the script owner's.
 */
function syncWeeklyPlanCalendar(planId, viewer, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  var sheet = weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows = sheet.getDataRange().getValues();
  for (var r=1; r<rows.length; r++) {
    if (String(rows[r][0]) !== String(planId) || String(rows[r][3]||'').toLowerCase() !== user.email) continue;
    try {
      var plan = weeklyPlanObject_(rows[r]);
      var virtualCalendar=CalendarApp.getDefaultCalendar();
      var virtualOrganiser=weeklyPlanLower_(rows[r][55]||user.email);
      if(weeklyPlanLower_(virtualCalendar.getId())!==virtualOrganiser)return {ok:false,message:'This Meet is on '+virtualOrganiser+'’s calendar. Ask the organiser to update or cancel it.'};
      if (plan.meetingType==='Virtual' && plan.calendarEventId) {
        var virtualEvent=virtualCalendar.getEventById(plan.calendarEventId);
        if(!virtualEvent)return {ok:false,message:'This Calendar invitation was not found on the organiser’s calendar.'};
        if(String(plan.status).toLowerCase()==='closed'){
          virtualEvent.deleteEvent();sheet.getRange(r+1,30).setValue('');
          return {ok:true,removed:true,planId:plan.id};
        }
        var virtualStart=weeklyPlanCalendarDate_(plan.meetingDate,plan.meetingTime);
        if(!virtualStart)return {ok:false,message:'Virtual meeting needs a date and time.'};
        virtualEvent.setTime(virtualStart,new Date(virtualStart.getTime()+45*60000));
        return {ok:true,planId:plan.id,eventId:plan.calendarEventId,meetUrl:plan.googleMeetUrl};
      }
      var calendar = CalendarApp.getDefaultCalendar();
      var calendarId = String(calendar.getId() || '').toLowerCase();
      if (user.email && calendarId && calendarId !== user.email) {
        return {ok:false, message:'Calendar is not running as the KAM. Redeploy the web app to execute as the user accessing it, then authorise Calendar once.'};
      }
      var event = plan.calendarEventId ? calendar.getEventById(plan.calendarEventId) : null;
      if (!plan.meetingTime && String(plan.status).toLowerCase()!=='closed') {
        if(event){event.deleteEvent();sheet.getRange(r+1,30).setValue('');}
        return {ok:false,message:'Date-only plan: no timed Calendar block. Any old timed block was removed. Add an explicit time through Reschedule to sync.'};
      }
      if (String(plan.status).toLowerCase() === 'closed') {
        if (event) event.deleteEvent();
        sheet.getRange(r+1,30).setValue('');
        return {ok:true, removed:true, planId:plan.id};
      }
      var start = weeklyPlanCalendarDate_(plan.meetingDate, plan.meetingTime);
      if (!start) return {ok:false, message:'Add a valid meeting date and time before calendar sync.'};
      var end = new Date(start.getTime() + 45 * 60 * 1000);
      var title = 'Brahmastra Beat · ' + (plan.restaurant || 'Merchant meeting');
      var description = [
        'Cluster: ' + (plan.cluster || '—'),
        plan.resId ? 'Res ID: ' + plan.resId : '',
        plan.objective ? '\nObjective\n' + weeklyPlanMerchantSafeObjective_(plan.objective) : '',
        plan.talkingPoints ? '\nTalking points\n' + weeklyPlanMerchantSafeTalkingPoints_(plan.talkingPoints) : '',
        plan.nextAction ? '\nNext action\n' + plan.nextAction : ''
      ].filter(function(x){ return x !== ''; }).join('\n');
      if (event) {
        event.setTitle(title).setTime(start,end).setDescription(description).setLocation(plan.city || '');
      } else {
        event = calendar.createEvent(title,start,end,{description:description,location:plan.city || ''});
        sheet.getRange(r+1,30).setValue(event.getId());
      }
      return {ok:true, planId:plan.id, eventId:event.getId()};
    } catch(e) {
      var calendarError=String(e.message || e);
      if (/permission|authori[sz]|auth\/calendar|calendar\.readonly|calendar\/feeds/i.test(calendarError)) {
        calendarError='Calendar permission is not authorised. In Apps Script run AuthoriseBrahmastraWeeklyCalendar, approve Google Calendar, then deploy a new version with Execute as: User accessing the web app.';
      }
      return {ok:false, message:'Calendar sync could not complete: '+calendarError};
    }
  }
  return {ok:false, message:'This meeting plan is not available for your account.'};
}

function beatGoogleJson_(url,method,body) {
  var options={method:method||'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
  if(body!==undefined){options.contentType='application/json';options.payload=JSON.stringify(body);}
  var response=UrlFetchApp.fetch(url,options),code=response.getResponseCode(),raw=response.getContentText();
  var data={};try{data=JSON.parse(raw);}catch(ignore){}
  if(code<200||code>=300){
    var message=(data.error&&data.error.message)||('Google API returned '+code);
    var project=(String(message).match(/project\s+(\d+)/i)||[])[1];
    if(/calendar-json\.googleapis\.com|Google Calendar API has not been used|Calendar API.*disabled/i.test(message))
      throw new Error('Google Calendar API is disabled for the Apps Script Cloud project'+(project?' '+project:'')+'. An owner of that project must enable it in Google Cloud → APIs & Services → Library → Google Calendar API'+(project?' (https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project='+project+')':'')+'. This is a one-time project setup; approving Calendar permission or redeploying alone cannot enable it. Wait a few minutes after enabling, then retry.');
    throw new Error(message);
  }
  return data;
}

function beatGoogleDocText_(id) {
  var doc=beatGoogleJson_('https://docs.googleapis.com/v1/documents/'+encodeURIComponent(id),'get'),lines=[];
  function walk(elements){(elements||[]).forEach(function(item){if(item.paragraph){var line=(item.paragraph.elements||[]).map(function(part){return part.textRun?part.textRun.content||'':'';}).join('').trim();if(line)lines.push(line);}if(item.table)(item.table.tableRows||[]).forEach(function(row){(row.tableCells||[]).forEach(function(cell){walk(cell.content);});});});}
  walk(doc.body&&doc.body.content);
  return lines.join('\n');
}

function beatVirtualCalendarActor_(user) {
  var actor='';
  try { actor=weeklyPlanLower_(Session.getActiveUser().getEmail()); } catch(ignore) {}
  if(!actor)throw new Error('Sign in with your own Google account to schedule Meet. The web app must execute as the user accessing it.');
  if(actor!==weeklyPlanLower_(user.email)&&!(user.isViewingAs&&isSuperUser_(actor)&&weeklyPlanLower_(user.actualEmail)===actor))throw new Error('Only the assigned KAM or a super admin viewing that KAM can schedule this Meet.');
  var calendar=CalendarApp.getDefaultCalendar();
  if(weeklyPlanLower_(calendar.getId())!==actor)throw new Error('Calendar is not running as your signed-in account. Deploy as User accessing the web app and authorise Calendar.');
  return actor;
}

function scheduleWeeklyPlanVirtualMeeting(planId,merchantEmail,timeValue,viewer,clusterOverride,viewAsKam,meetUrl) {
  var email=String(merchantEmail||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid merchant email address.');
  var suppliedMeet=String(meetUrl||'').trim();
  if(suppliedMeet&&!/^https:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}(?:[/?#].*)?$/i.test(suppliedMeet))throw new Error('Paste a valid Google Meet link, or leave the Meet link blank.');
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),actor=beatVirtualCalendarActor_(user),sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues();
  for(var r=1;r<rows.length;r++){
    if(String(rows[r][0])!==String(planId)||weeklyPlanLower_(rows[r][3])!==weeklyPlanLower_(user.email))continue;
    var plan=weeklyPlanObject_(rows[r]),start=weeklyPlanCalendarDate_(plan.meetingDate,timeValue);
    if(!start||start.getTime()<=Date.now())throw new Error('Choose a future meeting time on the planned date.');
    var organiser=weeklyPlanLower_(rows[r][55]||user.email);
    if(plan.calendarEventId&&organiser!==actor)throw new Error('This invitation belongs to '+organiser+'’s calendar. Ask that organiser to change it.');
    var calendar=CalendarApp.getDefaultCalendar(),event=plan.calendarEventId?calendar.getEventById(plan.calendarEventId):null;
    if(plan.calendarEventId&&!event)throw new Error('An existing invitation cannot be found on this calendar. Ask its organiser to manage it before scheduling again.');
    var meet=suppliedMeet||plan.googleMeetUrl||'';
    var guests=[email];if(actor!==weeklyPlanLower_(user.email)&&email!==weeklyPlanLower_(user.email))guests.push(user.email);
    var title='Beat Plan · '+plan.restaurant,description='Merchant meeting with '+plan.restaurant+'\nAgenda: '+weeklyPlanMerchantSafeObjective_(plan.objective)+(meet?'\nJoin Google Meet: '+meet:'');
    var end=new Date(start.getTime()+45*60000);
    if(event){
      event.setTitle(title).setTime(start,end).setDescription(description);
      if(meet)event.setLocation(meet);
      var oldMerchant=weeklyPlanLower_(plan.virtualMerchantEmail);
      if(oldMerchant&&oldMerchant!==email&&oldMerchant!==weeklyPlanLower_(user.email))event.removeGuest(oldMerchant);
      var present=event.getGuestList().map(function(g){return weeklyPlanLower_(g.getEmail());});
      guests.forEach(function(g){if(present.indexOf(g)<0)event.addGuest(g);});
    }else event=calendar.createEvent(title,start,end,{description:description,location:meet,guests:guests.join(','),sendInvites:true});
    sheet.getRange(r+1,10).setValue(weeklyPlanTime_(timeValue));
    sheet.getRange(r+1,30).setValue(event.getId());
    sheet.getRange(r+1,43).setValue('Virtual');
    sheet.getRange(r+1,52).setValue(email);
    sheet.getRange(r+1,56).setValue(actor);
    sheet.getRange(r+1,53).setValue(meet);
    sheet.getRange(r+1,17).setValue(new Date());
    return {ok:true,meetUrl:meet,eventId:event.getId(),organiserEmail:actor,kamEmail:user.email,calendarOnly:!meet,plan:weeklyPlanObject_(sheet.getRange(r+1,1,1,WEEKLY_PLAN_HEADERS_.length).getValues()[0])};
  }
  throw new Error('Meeting not available for your account.');
}

function importWeeklyPlanMeetNotes(planId,viewer,clusterOverride,viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues();
  for(var r=1;r<rows.length;r++){
    if(String(rows[r][0])!==String(planId)||weeklyPlanLower_(rows[r][3])!==weeklyPlanLower_(user.email))continue;
    var plan=weeklyPlanObject_(rows[r]);
    if(!plan.googleMeetUrl)return {ok:false,message:'Schedule a Google Meet first.'};
    if(plan.meetNotesUrl)return {ok:true,notesUrl:plan.meetNotesUrl,notes:plan.manualMeetingNotes||'',message:'Meet notes already imported.'};
    var code=(plan.googleMeetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/i)||[])[1];
    if(!code)return {ok:false,message:'Meet link has no meeting code.'};
    var list=beatGoogleJson_('https://meet.googleapis.com/v2/conferenceRecords?filter='+encodeURIComponent('space.meeting_code = "'+code+'"')+'&pageSize=10','get');
    var records=(list.conferenceRecords||[]).filter(function(x){return x.endTime&&x.startTime&&Utilities.formatDate(new Date(x.startTime),'Asia/Kolkata','yyyy-MM-dd')===plan.meetingDate;});
    if(!records.length)return {ok:false,message:'Meeting has not ended or its record is not available yet.'};
    for(var i=0;i<records.length;i++){
      var notes=beatGoogleJson_('https://meet.googleapis.com/v2/'+records[i].name+'/smartNotes','get').smartNotes||[];
      for(var j=0;j<notes.length;j++){
        if(notes[j].state!=='FILE_GENERATED'||!notes[j].docsDestination)continue;
        var destination=notes[j].docsDestination,docId=destination.document||'';
        var url=destination.exportUri||('https://docs.google.com/document/d/'+docId+'/edit');
        if(!docId)continue;
        var body=beatGoogleDocText_(docId).trim();
        if(!body)continue;
        var existingNotes=String(rows[r][39]||'').trim();
        var combinedNotes=(existingNotes?existingNotes+'\n\n--- Google Meet AI notes ---\n':'')+body;
        sheet.getRange(r+1,40).setValue(combinedNotes.slice(0,48000));
        sheet.getRange(r+1,42).setValue('Google Meet smart notes imported; not a verbatim transcript');
        sheet.getRange(r+1,54).setValue(url);
        sheet.getRange(r+1,55).setValue(new Date());
        return {ok:true,notes:combinedNotes.slice(0,48000),importedNotes:body,notesUrl:url,message:'Meet notes imported.'};
      }
    }
    return {ok:false,message:'No generated Meet notes yet. Turn on Take notes for me during the meeting, or type notes manually.'};
  }
  throw new Error('Meeting not available for your account.');
}

/** Syncs all open plans for the displayed week. Useful after the automatic
 * route builder has added many stops at once. */
function syncWeeklyPlanWeekCalendar(weekStart, viewer, clusterOverride, viewAsKam) {
  var user = weeklyPlanUser_(viewer, clusterOverride, viewAsKam);
  var plans = weeklyPlanRows_(user.email, weekStart).filter(function(p){ return String(p.status).toLowerCase() !== 'closed'; });
  var synced=0, failed=[];
  plans.forEach(function(plan){ var result=syncWeeklyPlanCalendar(plan.id, viewer, clusterOverride, viewAsKam); if(result.ok) synced++; else failed.push(result.message); });
  return {ok:failed.length===0, synced:synced, total:plans.length, message:failed[0] || ''};
}

function weeklyPlanCalendarDate_(dateValue, timeValue) {
  var date = weeklyPlanDate_(dateValue), time = weeklyPlanTime_(timeValue);
  if (!date || !/^\d{2}:\d{2}$/.test(time)) return null;
  var parts=time.split(':');
  var d=new Date(date+'T12:00:00');
  d.setHours(Number(parts[0]),Number(parts[1]),0,0);
  return d;
}

function weeklyPlanBook_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(WEEKLY_PLAN_PROP_);
  var book;
  try { book = id ? SpreadsheetApp.openById(id) : null; } catch(e) { book = null; }
  if (!book) {
    book = SpreadsheetApp.create('Brahmastra — Weekly Merchant Plans');
    props.setProperty(WEEKLY_PLAN_PROP_, book.getId());
  }
  // Wrap only the plan tab. Auxiliary configuration/feedback tabs may remain
  // in the workbook, but all Beat Plan state is JSON-only.
  return {
    getId:function(){return book.getId();},getUrl:function(){return book.getUrl();},getSheets:function(){return book.getSheets();},
    getSheetByName:function(name){return String(name)===WEEKLY_PLAN_SHEET_?ahmedabadPlanSheetAdapter_():book.getSheetByName(name);},
    insertSheet:function(name){if(String(name)===WEEKLY_PLAN_SHEET_)return ahmedabadPlanSheetAdapter_();return book.insertSheet(name);}
  };
}

function weeklyPlanRows_(email, weekStart) {
  var sheet = weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  if (sheet.getLastRow() < 2) return [];
  var want = weeklyPlanDate_(weekStart), values=sheet.getDataRange().getValues().slice(1), windows={};
  return sheet.getDataRange().getValues().slice(1).filter(function(row){
    if(String(row[3]).toLowerCase()!==String(email).toLowerCase())return false;
    var cluster=String(row[4]||'');if(!windows[cluster])windows[cluster]=beatPilotWindow_({email:email,cluster:cluster},want);
    return windows[cluster].indexOf(weeklyPlanDate_(row[2]))>=0;
  }).map(weeklyPlanObject_).sort(function(a,b){ return String(a.meetingDate+a.meetingTime).localeCompare(String(b.meetingDate+b.meetingTime)); });
}

function weeklyPlanLower_(value) { return String(value || '').toLowerCase().trim(); }
function weeklyPlanDisplayName_(email) { var raw=String(email||'').split('@')[0].replace(/[._-]+/g,' ').trim(); return raw.replace(/\b\w/g,function(c){return c.toUpperCase();}) || 'Unassigned'; }
function weeklyPlanRoleType_(user) { var r=weeklyPlanLower_(user && user.role); if(r.indexOf('kam')>=0)return 'kam'; if(r.indexOf('zh')>=0||r.indexOf('tl')>=0)return 'zh'; if(r.indexOf('ceo')>=0)return 'ceo'; return 'core'; }
function weeklyPlanClusterMatch_(a,b) { var scope=weeklyPlanLower_(b); if(!scope||/super|all/.test(scope))return true; return weeklyPlanLower_(a).replace(/[^a-z0-9]/g,'')===scope.replace(/[^a-z0-9]/g,''); }
function weeklyPlanPeople_() { var people={}; (loadMaster_()||[]).forEach(function(row){var email=weeklyPlanLower_(row.kam_email||row.kamemail);if(!email)return;if(!people[email])people[email]={};if(!people[email].zhEmail)people[email].zhEmail=weeklyPlanLower_(row.zh_email||row.tl_email||row.zhemail||row.tlemail);if(!people[email].cluster)people[email].cluster=String(row.city_cluster||row.cluster||'');});return people; }
function weeklyPlanScopedRows_(user, weekStart) {
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_); if(sheet.getLastRow()<2)return [];
  var role=weeklyPlanRoleType_(user), viewer=weeklyPlanLower_(user.email), scope=user.cluster, people=weeklyPlanPeople_(), want=weeklyPlanDate_(weekStart);
  var windowDates=beatPilotWindow_(user,want);
  return sheet.getDataRange().getValues().slice(1).map(function(row){var plan=weeklyPlanObject_(row);plan.routeOrder=weeklyPlanNumber_(row[56]);return plan;}).filter(function(plan){
    var meta=people[weeklyPlanLower_(plan.kamEmail)]||{}; plan.zhEmail=meta.zhEmail||''; plan.zhName=weeklyPlanDisplayName_(plan.zhEmail); plan.kamName=weeklyPlanDisplayName_(plan.kamEmail);
    if(windowDates.indexOf(plan.meetingDate)<0||!weeklyPlanClusterMatch_(plan.cluster||meta.cluster,scope))return false;
    if(role==='kam')return weeklyPlanLower_(plan.kamEmail)===viewer;
    if(role==='zh')return weeklyPlanLower_(plan.zhEmail)===viewer;
    return true;
  }).sort(function(a,b){return a.meetingDate.localeCompare(b.meetingDate)||(a.routeOrder&&b.routeOrder?a.routeOrder-b.routeOrder:0)||String(a.meetingTime).localeCompare(String(b.meetingTime));});
}
function weeklyPlanTeamReview_(user, weekStart) {
  if(weeklyPlanRoleType_(user)==='kam')return null;
  var plans=weeklyPlanScopedRows_(user,weekStart), kams={}, zhs={};
  plans.forEach(function(p){var k=weeklyPlanLower_(p.kamEmail),z=weeklyPlanLower_(p.zhEmail)||'unassigned';if(!kams[k])kams[k]={email:k,name:p.kamName,zhEmail:z,total:0,met:0,commitments:0,pending:0};var kg=kams[k];kg.total++;if(['met','closed'].indexOf(weeklyPlanLower_(p.status))>=0)kg.met++;else kg.pending++;if(String(p.merchantCommitment||'').trim())kg.commitments++;if(!zhs[z])zhs[z]={email:z,name:p.zhName,total:0,met:0,commitments:0,pending:0,kams:0};var zg=zhs[z];zg.total++;if(['met','closed'].indexOf(weeklyPlanLower_(p.status))>=0)zg.met++;else zg.pending++;if(String(p.merchantCommitment||'').trim())zg.commitments++;});
  Object.keys(kams).forEach(function(k){kams[k].adherence=kams[k].total?Math.round(kams[k].met*100/kams[k].total):0;});Object.keys(zhs).forEach(function(k){zhs[k].adherence=zhs[k].total?Math.round(zhs[k].met*100/zhs[k].total):0;zhs[k].kams=Object.keys(kams).filter(function(e){return kams[e].zhEmail===k;}).length;});
  var total=plans.length,met=plans.filter(function(p){return ['met','closed'].indexOf(weeklyPlanLower_(p.status))>=0;}).length,commitments=plans.filter(function(p){return String(p.merchantCommitment||'').trim();}).length;
  return {total:total,met:met,adherence:total?Math.round(met*100/total):0,commitments:commitments,kams:Object.keys(kams).map(function(k){return kams[k];}).sort(function(a,b){return b.pending-a.pending||b.total-a.total;}),zhs:Object.keys(zhs).map(function(k){return zhs[k];}).sort(function(a,b){return b.pending-a.pending||b.total-a.total;})};
}

function weeklyPlanObject_(r) {
  var meetingPoint=null;try{meetingPoint=JSON.parse(String(r[50]||'null'));}catch(ignorePoint){}
  var outlets=[]; try { outlets=JSON.parse(String(r[45]||'[]')); } catch(ignore) {}
  // Legacy comma-separated IDs can be coerced into one number by Sheets.
  // Recover exact IDs from the independently saved outlet JSON, never by
  // guessing digit boundaries in a potentially rounded spreadsheet number.
  r=r.slice();
  var mappedIds=weeklyPlanIdList_(Array.isArray(outlets)?outlets.map(function(o){return o && o.id;}):[]);
  if(mappedIds.length) r[44]=JSON.stringify(mappedIds);
  var allowed=weeklyPlanIdList_(r[44]||r[5]);
  r[46]=JSON.stringify(weeklyPlanIdList_(r[46]).filter(function(id){return allowed.indexOf(id)>=0;}));
  return {meetingPoint:meetingPoint,id:String(r[0]||''),weekStart:weeklyPlanDate_(r[1]),meetingDate:weeklyPlanDate_(r[2]),kamEmail:String(r[3]||''),cluster:String(r[4]||''),resId:String(r[5]||''),restaurant:String(r[6]||''),city:String(r[7]||''),priority:String(r[8]||'P1'),meetingTime:weeklyPlanTime_(r[9]),objective:String(r[10]||''),talkingPoints:String(r[11]||''),deckLink:String(r[12]||''),nextAction:String(r[13]||''),followUpDate:weeklyPlanDate_(r[14]),status:String(r[15]||'Planned'),updatedAt:weeklyPlanDateTime_(r[16]),completedAt:weeklyPlanDateTime_(r[17]),source:String(r[18]||'Manual'),priorityScore:weeklyPlanNumber_(r[19]),autoRationale:String(r[20]||''),meetingOutcome:String(r[21]||''),merchantCommitment:String(r[22]||''),kamCommitment:String(r[58]||''),mxCommitment:String(r[59]||r[22]||''),commitmentOwner:String(r[23]||''),commitmentDueDate:weeklyPlanDate_(r[24]),checkedInAt:String(r[25]||''),checkedOutAt:String(r[26]||''),latitude:weeklyPlanLatitude_(r[27]),longitude:weeklyPlanLongitude_(r[28]),calendarEventId:String(r[29]||''),arrivedAt:String(r[30]||''),arrivalLatitude:weeklyPlanLatitude_(r[31]),arrivalLongitude:weeklyPlanLongitude_(r[32]),arrivalDistanceMetres:weeklyPlanNumber_(r[33]),meetingStartedAt:String(r[34]||''),meetingEndedAt:String(r[35]||''),recordingUrl:String(r[36]||''),recordingFileId:String(r[37]||''),liveTranscript:String(r[38]||''),manualMeetingNotes:String(r[39]||''),meetingSummary:String(r[40]||''),transcriptStatus:String(r[41]||''),meetingType:weeklyPlanMeetingType_(r[42]),plannedMode:weeklyPlanMeetingType_(r[57])||'Physical',commitmentReminderSentAt:weeklyPlanDateTime_(r[43]),brandResIds:weeklyPlanIdList_(r[44]||r[5]),brandOutletLocations:Array.isArray(outlets)?outlets:[],selectedResIds:weeklyPlanIdList_(r[46]||''),visitLocationType:String(r[47]||'Merchant outlets'),virtualMerchantEmail:String(r[51]||''),googleMeetUrl:String(r[52]||''),meetNotesUrl:String(r[53]||''),meetNotesImportedAt:weeklyPlanDateTime_(r[54])};
}

function weeklyPlanMeetingType_(value) {
  var type=String(value||'').toLowerCase();
  return type==='call'?'Call':type==='virtual'?'Virtual':type==='physical'||type==='on-site'?'Physical':'';
}

function weeklyPlanIdList_(value) {
  var seen={}, out=[];
  function add(value) {
    if(Array.isArray(value)){value.forEach(add);return;}
    var text=String(value==null?'':value).trim();
    if(!text)return;
    if(text.charAt(0)==='['){try{var parsed=JSON.parse(text);if(Array.isArray(parsed)){parsed.forEach(add);return;}}catch(ignore){} }
    text.split(/[\s,;|]+/).forEach(function(id){if(/^\d+$/.test(id)&&!seen[id]){seen[id]=true;out.push(id);}});
  }
  add(value);
  return out;
}

// Read-only route estimate. Resolve both endpoints server-side from the KAM's
// office and authorised JSON plan; never accept arbitrary client coordinates.
function getBeatFirstStopTravel(planId, viewer, clusterOverride, viewAsKam) {
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_);
  var rows=sheet?sheet.getDataRange().getValues():[],plan=null;
  for(var i=1;i<rows.length;i++)if(String(rows[i][0])===String(planId)&&String(rows[i][3]).toLowerCase()===user.email){plan=weeklyPlanObject_(rows[i]);break;}
  if(!plan)throw new Error('This meeting is not available in your KAM view.');
  function coordinate(v,max){return v!==null&&v!==undefined&&String(v).trim()!==''&&isFinite(Number(v))&&Math.abs(Number(v))<=max;}
  if(!coordinate(user.officeLatitude,90)||!coordinate(user.officeLongitude,180))throw new Error('Office coordinates are missing in the master mapping.');
  if(!coordinate(plan.latitude,90)||!coordinate(plan.longitude,180))throw new Error('First merchant coordinates are missing.');
  var origin=user.officeLatitude+','+user.officeLongitude,destination=plan.latitude+','+plan.longitude;
  var key='beatDriving:'+origin+':'+destination,cache=CacheService.getScriptCache(),cached=cache.get(key);
  if(cached)return JSON.parse(cached);
  var result=Maps.newDirectionFinder().setOrigin(Number(user.officeLatitude),Number(user.officeLongitude)).setDestination(Number(plan.latitude),Number(plan.longitude)).setMode(Maps.DirectionFinder.Mode.DRIVING).setDepart(new Date()).getDirections();
  var leg=result.routes&&result.routes[0]&&result.routes[0].legs&&result.routes[0].legs[0];
  if(!leg||!leg.duration||!leg.distance)throw new Error('No driving route returned. Please retry later.');
  var duration=leg.duration_in_traffic||leg.duration;
  var response={duration:duration.text,distance:leg.distance.text,traffic:!!leg.duration_in_traffic,checkedAt:new Date().toISOString(),url:'https://www.google.com/maps/dir/?api=1&origin='+encodeURIComponent(origin)+'&destination='+encodeURIComponent(destination)+'&travelmode=driving'};
  cache.put(key,JSON.stringify(response),180);return response;
}

function weeklyPlanUser_(viewer, clusterOverride, viewAsKam) {
  try { setClusterOverride_(clusterOverride || ''); setViewAsKam_(viewAsKam || ''); setViewer_(viewer || ''); } catch(ignore) {}
  var ctx = {};
  try { ctx = getUserContext() || {}; } catch(ignore2) {}
  // In authorised View-as-KAM mode, the schedule belongs to the selected KAM
  // (not the CEO who opened the preview). Normal users always retain their
  // actual account identity.
  var email = String((ctx.isViewingAs && ctx.email) || ctx.actualEmail || viewer || '').toLowerCase().trim();
  if (!email) { try { email = String(Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase().trim(); } catch(ignore3) {} }
  if (!email) email = String(PropertiesService.getScriptProperties().getProperty('WEEKLY_PLAN_TEST_EMAIL') || 'unknown@zomato.com').toLowerCase().trim();
  var officeRow=null;try{officeRow=loadMaster_().filter(function(r){return weeklyPlanLower_(r.kam_email)===email;})[0]||null;}catch(ignore4){}
  var direct={};try{direct=resolveViewer_(weeklyPlanLower_(ctx.actualEmail||viewer||email),clusterOverride||'')||{};}catch(ignore5){}
  var role=String(ctx.role||'');if(!role||weeklyPlanLower_(role)==='unknown')role=String(direct.role||'KAM');
  return {email:email, actualEmail:String(ctx.actualEmail||'').toLowerCase().trim(), isViewingAs:!!ctx.isViewingAs, cluster:String(ctx.cluster || direct.cluster || clusterOverride || ''), role:role, isAdmin:!!(ctx.actualIsAdmin || ctx.isAdmin || ctx.isSuper || direct.isPlus),officeLatitude:officeRow?officeRow.office_latitude:direct.officeLatitude,officeLongitude:officeRow?officeRow.office_longitude:direct.officeLongitude};
}

// Sheets stores a time-only cell with a placeholder date in December 1899.
// The UI must show only the intended clock time, never that placeholder date.
function weeklyPlanTime_(value) {
  if (value === '' || value == null) return '';
  var raw=String(value), match=raw.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (match) return ('0'+Number(match[1])).slice(-2)+':'+match[2];
  if (typeof value === 'number' && value >= 0 && value < 1) {
    var mins=Math.round(value*24*60), hours=Math.floor(mins/60)%24;
    return ('0'+hours).slice(-2)+':'+('0'+(mins%60)).slice(-2);
  }
  return raw;
}
function weeklyPlanDate_(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value).slice(0,10);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
}
function weeklyPlanDateTime_(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? String(value) : Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd HH:mm');
}
function weeklyPlanMonday_(value) {
  var d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  var day = d.getDay(); d.setDate(d.getDate() - (day === 0 ? 6 : day-1));
  return weeklyPlanDate_(d);
}

// Usage-tracker spreadsheet.
const TRACKER_SHEET_ID = '1EH0Av88HmA-pZVLbEoBUNc9GAD3U_I6wD_OjdWSo6zM';
// Historical KAM-wise drive-score archive requested for completed drives.
const DRIVE_HISTORY_SHEET_ID = '1Pagow3Da72uhfSByOcbr1sZUPuRdtK9CECe1vFtSQTI';
// Quarterly KAM leaderboard (published business sheet; ranks are maintained
// there, so the dashboard only reads and presents them).
const LEADERBOARD_SHEET_ID = '1E4y7Vt0gMb_UwtXLpcD4RUPgB-BcOA1nL1WmzTp6DPQ';
const LEADERBOARD_BHARAT_TAB = "Bharat KAM - JAS'26 - Scorecard";
const LEADERBOARD_INDIA_TAB  = "India KAM - JAS'26 - Scorecard";
// ZH/TL scorecards carry the same column contract as the corresponding KAM
// scorecards, but must never be mixed with KAM leaderboard rows.
const LEADERBOARD_BHARAT_ZH_TAB = "Bharat ZH - JAS'26 - Scorecard";
const LEADERBOARD_INDIA_ZH_TAB  = "India ZH - JAS'26 - Scorecard";
const INDIA_LEADERBOARD_CLUSTERS = ['West Bengal + Odisha','Maharashtra','Mumbai','Vadodara','Jammu','Patna','Rayalaseema'];

// Valid period granularities for this app.
const PERIODS = ['day','week','lastweek','month','quarter'];

// Super-core-admin: can see ALL clusters (KAM-level, no res) OR pick any one
// cluster via the dropdown on top.
const SUPER_USERS = [
  'sachin.bajaj@zomato.com',
  'sourab.kohli@zomato.com',
  'harsh.puvar@zomato.com',
  'ankur.lakhani@zomato.com'
];
// Settings-managed Super Core admins.  SUPER_USERS above are the bootstrap
// owners; this property lets them grant/revoke future Super Core access with
// no code edit or redeployment.
const SUPER_ADMIN_PROP = 'SUPER_CORE_ADMINS';

function getDynamicSuperUsers_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SUPER_ADMIN_PROP);
    var a = raw ? JSON.parse(raw) : [];
    return (a || []).map(function(e){ return String(e||'').trim().toLowerCase(); }).filter(Boolean);
  } catch (e) { return []; }
}
function getSuperUsers_() { return uniq_(SUPER_USERS.concat(getDynamicSuperUsers_())); }
function isSuperUser_(email) {
  email = String(email||'').trim().toLowerCase();
  return !!email && getSuperUsers_().indexOf(email) !== -1;
}

// Core users can grant a person admin access to one chosen cluster without
// turning that person into a Super Core Admin. The map is email -> clusters.
const CLUSTER_ADMIN_PROP = 'BRAHMASTRA_CLUSTER_ADMINS';
function clusterAdminMap_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(CLUSTER_ADMIN_PROP);
    var map = raw ? JSON.parse(raw) : {};
    return (map && typeof map === 'object') ? map : {};
  } catch (e) { return {}; }
}
function clusterAdminMapSave_(map) {
  try { PropertiesService.getScriptProperties().setProperty(CLUSTER_ADMIN_PROP, JSON.stringify(map || {})); } catch (e) {}
}
function clusterAdminClusters_(email) {
  email = String(email || '').trim().toLowerCase();
  var vals = clusterAdminMap_()[email] || [];
  return uniq_((vals || []).map(function(c){ return String(c || '').trim(); }).filter(Boolean));
}
function clusterAdminUsers_(cluster) {
  var key = clusterKey_(cluster || ''), map = clusterAdminMap_(), out = [];
  Object.keys(map).forEach(function(email){
    var found = (map[email] || []).some(function(c){ return clusterKey_(c) === key; });
    if (found) out.push(String(email).toLowerCase());
  });
  return out.sort();
}

// ===========================================================================
// MULTI-CLUSTER MASTER ROUTING  (Brahmastra)
// ---------------------------------------------------------------------------
// A live Google Sheet ("master") maps every user to a cluster + that cluster's
// Drive folder. On each request we look up the viewer, resolve their cluster
// folder, and read that folder's CSVs. Super-admins read a separate KAM-level
// folder (no res files).
//
// Master sheet columns: city_cluster | folder_id | ceo_email | zh_email | kam_email
// (one row per kam; ceo/zh repeat down the cluster's rows)
// ===========================================================================
// Ahmedabad-only pilot. The HTML remains universal; this backend deliberately
// resolves every authorised Ahmedabad KAM against this one data folder.
const AHMEDABAD_DATA_FOLDER_ID = '1lMPl21A3usjnpYGPGnrw_HfNfWukQMmJ';
const MASTER_FOLDER_ID   = AHMEDABAD_DATA_FOLDER_ID;
const MASTER_SHEET_ID    = '1UXyghrgANOM7R0ScYteJxh9xOSaFmVaT7Xgn9h7ObW8';
const SUPERADMIN_FOLDER_ID = AHMEDABAD_DATA_FOLDER_ID;
const MASTER_SHEET_NAME  = 'master'; // falls back to the first tab when named differently
const AHMEDABAD_JSON_CACHE_VERSION = 3;
const AHMEDABAD_JSON_CACHE_PREFIX = 'beat_plan_ahmedabad_';
const AHMEDABAD_PLAN_STORE_PREFIX = 'beat_plan_ahmedabad_store_';
const AHMEDABAD_JSON_MAX_BYTES = 28 * 1024 * 1024;
const BEAT_ACTIVITY_FILE_NAME = 'beat_activity_log.json';
const BEAT_ACTIVITY_MAX_BYTES = 28 * 1024 * 1024;
const BEAT_ACTIVITY_MAX_EVENTS = 20000;
const BEAT_SUPPORT_FILE_NAME = 'beat_support_messages.json';
const BEAT_SUPPORT_MAX_BYTES = 28 * 1024 * 1024;
const BEAT_SUPPORT_MAX_MESSAGES = 5000;
const BEAT_SUPPORT_ADMIN_POOL = '__superadmin_pool__';

/**
 * A single bounded audit file for the pilot. It stores operational metadata,
 * never meeting notes, transcripts or recording content. GPS is written only
 * when the KAM explicitly verifies a visit location in the UI.
 */
function beatActivityRead_() {
  try {
    var it=ahmedabadCacheFolder_().getFilesByName(BEAT_ACTIVITY_FILE_NAME);
    if(!it.hasNext())return {version:1,updatedAt:'',events:[]};
    var parsed=JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
    if(!parsed||!Array.isArray(parsed.events))return {version:1,updatedAt:'',events:[]};
    return parsed;
  } catch(e){return {version:1,updatedAt:'',events:[]};}
}
function beatActivityWrite_(store) {
  var folder=ahmedabadCacheFolder_(),body='',events=(store.events||[]).slice(-BEAT_ACTIVITY_MAX_EVENTS);
  do {
    store.events=events;store.updatedAt=new Date().toISOString();body=JSON.stringify(store);
    if(Utilities.newBlob(body).getBytes().length<=BEAT_ACTIVITY_MAX_BYTES)break;
    events=events.slice(Math.max(1,Math.floor(events.length*.12)));
  } while(events.length);
  var it=folder.getFilesByName(BEAT_ACTIVITY_FILE_NAME);
  if(it.hasNext())it.next().setContent(body);else folder.createFile(BEAT_ACTIVITY_FILE_NAME,body,MimeType.PLAIN_TEXT);
}
function beatActivityLog_(action,user,meta) {
  var lock=LockService.getScriptLock(),m=meta||{};
  try {
    lock.waitLock(15000);
    var store=beatActivityRead_(),actor=weeklyPlanLower_((user&&user.actualEmail)||m.actorEmail||(user&&user.email));
    store.events.push({
      id:Utilities.getUuid(),timestamp:new Date().toISOString(),action:String(action||'activity'),
      actorEmail:actor,kamEmail:weeklyPlanLower_(m.kamEmail||(user&&user.email)),cluster:String(m.cluster||(user&&user.cluster)||''),
      role:String((user&&user.role)||''),planId:String(m.planId||''),restaurant:String(m.restaurant||''),resId:String(m.resId||''),
      meetingDate:weeklyPlanDate_(m.meetingDate),meetingType:String(m.meetingType||''),status:String(m.status||''),
      latitude:weeklyPlanLatitude_(m.latitude),longitude:weeklyPlanLongitude_(m.longitude),accuracyMetres:weeklyPlanNumber_(m.accuracyMetres),
      source:String(m.source||'Beat Plan')
    });
    beatActivityWrite_(store);
  } catch(e){console.warn('Beat activity log skipped: '+e.message);}
  finally{try{lock.releaseLock();}catch(ignore){}}
}
function beatActivityPlanMeta_(row) {
  var p=weeklyPlanObject_(row);return {planId:p.id,kamEmail:p.kamEmail,cluster:p.cluster,restaurant:p.restaurant,resId:p.resId,meetingDate:p.meetingDate,meetingType:p.meetingType||p.plannedMode,status:p.status};
}

/** In-app field-support inbox. Messages stay in one bounded JSON file and
 * carry only the short help note plus meeting identity; transcripts, metric
 * snapshots and recordings are deliberately not copied here. */
function beatSupportRead_(){
  try{var it=ahmedabadCacheFolder_().getFilesByName(BEAT_SUPPORT_FILE_NAME);if(!it.hasNext())return {version:1,updatedAt:'',messages:[]};var parsed=JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));return parsed&&Array.isArray(parsed.messages)?parsed:{version:1,updatedAt:'',messages:[]};}catch(e){return {version:1,updatedAt:'',messages:[]};}
}
function beatSupportWrite_(store){
  var folder=ahmedabadCacheFolder_(),messages=(store.messages||[]).slice(-BEAT_SUPPORT_MAX_MESSAGES),body='';
  do{store.messages=messages;store.updatedAt=new Date().toISOString();body=JSON.stringify(store);if(Utilities.newBlob(body).getBytes().length<=BEAT_SUPPORT_MAX_BYTES)break;messages=messages.slice(Math.max(1,Math.floor(messages.length*.12)));}while(messages.length);
  var it=folder.getFilesByName(BEAT_SUPPORT_FILE_NAME);if(it.hasNext())it.next().setContent(body);else folder.createFile(BEAT_SUPPORT_FILE_NAME,body,MimeType.PLAIN_TEXT);
}
function beatSupportPlan_(planId,user){
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet?sheet.getDataRange().getValues():[];
  for(var i=1;i<rows.length;i++)if(String(rows[i][0])===String(planId)&&weeklyPlanLower_(rows[i][3])===weeklyPlanLower_(user.email)&&weeklyPlanClusterMatch_(rows[i][4],user.cluster))return weeklyPlanObject_(rows[i]);
  throw new Error('This meeting is not available in the selected KAM view.');
}
function beatSupportRecipientScope_(user){
  var allowed={},rows=loadMaster_()||[];rows.forEach(function(r){if(!weeklyPlanClusterMatch_(r.city_cluster,user.cluster))return;var kam=weeklyPlanLower_(r.kam_email),zh=weeklyPlanLower_(r.zh_email);if(kam)allowed[kam]='kam';if(zh)allowed[zh]='zh';});getSuperUsers_().forEach(function(email){email=weeklyPlanLower_(email);if(email)allowed[email]='superadmin';});return allowed;
}
function beatSupportRecentBrowserLocations_(freshMs){
  var latest={},now=Date.now();try{var rows=trackerSheet_('Locations').getDataRange().getValues();rows.slice(1).forEach(function(r){var email=weeklyPlanLower_(r[1]),ts=r[0] instanceof Date?r[0].getTime():Date.parse(r[0]),lat=weeklyPlanLatitude_(r[3]),lng=weeklyPlanLongitude_(r[4]);if(!email||weeklyPlanLower_(r[6])!=='granted'||!isFinite(ts)||now-ts>freshMs||lat===null||lng===null)return;var item={timestamp:new Date(ts).toISOString(),latitude:lat,longitude:lng,source:'Explicit browser location'};if(!latest[email]||String(latest[email].timestamp)<item.timestamp)latest[email]=item;});}catch(ignore){}return latest;
}
function getNearbyBeatSupport(planId,viewer,clusterOverride,viewAsKam){
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Open a KAM meeting to request nearby help.');
  var plan=beatSupportPlan_(planId,user),master=loadMaster_()||[],scope=beatSupportRecipientScope_(user),now=Date.now(),freshMs=8*60*60*1000,latest={},busy={},lastLifecycle={},browserLocations=beatSupportRecentBrowserLocations_(freshMs),actorEmail=weeklyPlanLower_(user.actualEmail||user.email);
  var originFromViewer=!!browserLocations[actorEmail],origin=originFromViewer?weeklyPlanRouteStart_(browserLocations[actorEmail]):weeklyPlanRouteStart_({latitude:plan.arrivalLatitude!=null?plan.arrivalLatitude:plan.latitude,longitude:plan.arrivalLongitude!=null?plan.arrivalLongitude:plan.longitude});
  // A KAM may open Help before verifying the checkpoint, or the merchant feed
  // may have stale/missing coordinates. Their explicit fresh GPS is the safe
  // fallback so genuinely nearby teammates are not accidentally hidden.
  if(!origin)origin=weeklyPlanRouteStart_({latitude:plan.arrivalLatitude!=null?plan.arrivalLatitude:plan.latitude,longitude:plan.arrivalLongitude!=null?plan.arrivalLongitude:plan.longitude});
  (beatActivityRead_().events||[]).slice().sort(function(a,b){return String(a.timestamp).localeCompare(String(b.timestamp));}).forEach(function(e){var email=weeklyPlanLower_(e.kamEmail),ts=Date.parse(e.timestamp||'');if(email===user.email||!scope[email])return;if(scope[email]==='kam'&&!weeklyPlanClusterMatch_(e.cluster,user.cluster))return;if(!isFinite(ts)||now-ts>freshMs)return;if(e.action==='arrival_verified'||e.action==='meeting_started'||e.action==='meeting_completed')lastLifecycle[email]={action:e.action,timestamp:ts};if(weeklyPlanLatitude_(e.latitude)!==null&&weeklyPlanLongitude_(e.longitude)!==null)latest[email]=e;});
  Object.keys(lastLifecycle).forEach(function(email){var state=lastLifecycle[email];busy[email]=(state.action==='arrival_verified'||state.action==='meeting_started')&&(now-state.timestamp<4*60*60*1000);});
  Object.keys(browserLocations).forEach(function(email){if(email===user.email||!scope[email])return;var e=browserLocations[email];if(!latest[email]||String(latest[email].timestamp)<String(e.timestamp))latest[email]=e;});
  // Nearby means both geographically recent and currently free. A KAM whose
  // latest meeting lifecycle is still at arrival/started is intentionally not
  // offered as available support.
  function person_(email,role){var e=latest[email],distance=origin&&e?weeklyPlanHaversineKm_(origin,{latitude:e.latitude,longitude:e.longitude}):null,mins=e?Math.max(0,Math.round((now-Date.parse(e.timestamp))/60000)):null,name=weeklyPlanDisplayName_(email);return {email:email,name:name,role:role,available:distance!==null&&distance<=25&&!busy[email],distanceKm:distance===null?null:Math.round(distance*10)/10,verifiedMinutesAgo:mins,currentMerchant:'Available nearby',initials:name.split(/\s+/).map(function(x){return x.charAt(0);}).join('').slice(0,2).toUpperCase()};}
  var kams=Object.keys(latest).filter(function(email){return scope[email]==='kam';}).map(function(email){return person_(email,'KAM');}).filter(function(p){return p.available;}).sort(function(a,b){return a.distanceKm-b.distanceKm;}).slice(0,8);
  var zhs={},zhList=[];master.forEach(function(r){if(!weeklyPlanClusterMatch_(r.city_cluster,user.cluster)||weeklyPlanLower_(r.kam_email)!==user.email)return;var email=weeklyPlanLower_(r.zh_email);if(!email||zhs[email])return;zhs[email]=true;var person=person_(email,'ZH / TL');if(person.available)zhList.push(person);});
  var admins=getSuperUsers_().filter(function(email){return weeklyPlanLower_(email)!==weeklyPlanLower_(user.actualEmail||user.email);}).map(function(email){return person_(weeklyPlanLower_(email),'Super Admin');}).filter(function(p){return p.available;}).sort(function(a,b){return a.distanceKm-b.distanceKm;});
  return {ok:true,originLabel:originFromViewer?'your current shared location':(plan.arrivedAt?'your verified checkpoint':(origin?'this meeting location':'location unavailable')),restaurant:plan.restaurant,resId:plan.resId,kams:kams,zhs:zhList,admins:admins,adminPool:admins.length?{email:BEAT_SUPPORT_ADMIN_POOL,name:'Super Admin',role:'Super Admin Pool',availableCount:admins.length,nearestKm:admins[0].distanceKm,initials:'SA'}:null};
}
function sendBeatSupportMessage(planId,recipientEmail,message,viewer,clusterOverride,viewAsKam){
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam);if(weeklyPlanRoleType_(user)!=='kam')throw new Error('Open a KAM meeting before requesting help.');
  var plan=beatSupportPlan_(planId,user),recipient=weeklyPlanLower_(recipientEmail),scope=beatSupportRecipientScope_(user),text=String(message||'').trim(),nearby=getNearbyBeatSupport(planId,viewer,clusterOverride,viewAsKam),available={},eligibleAdmins=(nearby.admins||[]).map(function(p){return weeklyPlanLower_(p.email);});[].concat(nearby.kams||[],nearby.zhs||[],nearby.admins||[]).forEach(function(p){available[weeklyPlanLower_(p.email)]=true;});var isAdminPool=recipient===BEAT_SUPPORT_ADMIN_POOL;if(isAdminPool&&eligibleAdmins.length===0)throw new Error('No location-verified Super Admin is nearby right now.');if(!isAdminPool&&(!scope[recipient]||!available[recipient]||recipient===user.email))throw new Error('This person is not currently location-verified and nearby. Refresh Help and choose an available person.');if(!text)throw new Error('Write a short help message.');if(text.length>600)throw new Error('Keep the message within 600 characters.');
  var lock=LockService.getScriptLock(),record;try{lock.waitLock(15000);var store=beatSupportRead_(),sender=weeklyPlanLower_(user.actualEmail||user.email);record={id:Utilities.getUuid(),timestamp:new Date().toISOString(),senderEmail:sender,senderKamEmail:user.email,recipientEmail:isAdminPool?BEAT_SUPPORT_ADMIN_POOL:recipient,recipientRole:isAdminPool?'superadmin_pool':scope[recipient],eligibleRecipients:isAdminPool?eligibleAdmins:[],claimStatus:isAdminPool?'open':'direct',claimedBy:'',cluster:user.cluster,planId:plan.id,restaurant:plan.restaurant,resId:plan.resId,meetingDate:plan.meetingDate,message:text,readAt:'',dismissedBy:[]};store.messages.push(record);beatSupportWrite_(store);}finally{try{lock.releaseLock();}catch(ignore){}}
  beatActivityLog_('support_message_sent',user,{planId:plan.id,kamEmail:user.email,cluster:user.cluster,restaurant:plan.restaurant,resId:plan.resId,meetingDate:plan.meetingDate,status:'Sent to '+recipient});return {ok:true,message:record};
}
function replyBeatSupportMessage(messageId,message,viewer,clusterOverride,viewAsKam){
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),actor=weeklyPlanLower_(user.actualEmail||user.email),text=String(message||'').trim();if(!text)throw new Error('Write a reply first.');if(text.length>600)throw new Error('Keep the reply within 600 characters.');
  var lock=LockService.getScriptLock(),reply;try{lock.waitLock(15000);var store=beatSupportRead_(),parent=null;(store.messages||[]).some(function(m){if(String(m.id)===String(messageId)){parent=m;return true;}return false;});if(!parent)throw new Error('This help request is no longer available.');var sender=weeklyPlanLower_(parent.senderEmail),recipient=weeklyPlanLower_(parent.recipientEmail),pool=recipient===BEAT_SUPPORT_ADMIN_POOL;if(pool){var eligible=(parent.eligibleRecipients||[]).map(weeklyPlanLower_);if(eligible.indexOf(actor)<0)throw new Error('This request is available only to nearby Super Admins.');if(parent.claimedBy&&weeklyPlanLower_(parent.claimedBy)!==actor)throw new Error('Another Super Admin has already picked this request.');parent.claimedBy=actor;parent.claimStatus='claimed';parent.recipientEmail=actor;recipient=actor;}if(actor!==sender&&actor!==recipient)throw new Error('Only conversation participants can reply.');var other=actor===sender?recipient:sender;reply={id:Utilities.getUuid(),threadId:String(parent.threadId||parent.id),parentId:String(parent.id),timestamp:new Date().toISOString(),senderEmail:actor,senderKamEmail:String(parent.senderKamEmail||''),recipientEmail:other,recipientRole:'reply',cluster:String(parent.cluster||''),planId:String(parent.planId||''),restaurant:String(parent.restaurant||''),resId:String(parent.resId||''),meetingDate:String(parent.meetingDate||''),message:text,readAt:''};parent.readAt=parent.readAt||new Date().toISOString();store.messages.push(reply);beatSupportWrite_(store);}finally{try{lock.releaseLock();}catch(ignore){}}return {ok:true,message:reply};
}
function getBeatSupportInbox(viewer,clusterOverride,viewAsKam){
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),recipient=weeklyPlanLower_(user.actualEmail||user.email);return (beatSupportRead_().messages||[]).filter(function(m){var direct=weeklyPlanLower_(m.recipientEmail)===recipient&&!m.readAt,pool=weeklyPlanLower_(m.recipientEmail)===BEAT_SUPPORT_ADMIN_POOL&&m.claimStatus!=='claimed'&&(m.eligibleRecipients||[]).map(weeklyPlanLower_).indexOf(recipient)>=0&&(m.dismissedBy||[]).map(weeklyPlanLower_).indexOf(recipient)<0;return direct||pool;}).sort(function(a,b){return String(b.timestamp).localeCompare(String(a.timestamp));}).slice(0,30);
}
function markBeatSupportMessageRead(messageId,viewer,clusterOverride,viewAsKam){
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),recipient=weeklyPlanLower_(user.actualEmail||user.email),lock=LockService.getScriptLock(),found=false;try{lock.waitLock(15000);var store=beatSupportRead_();store.messages.forEach(function(m){if(String(m.id)!==String(messageId))return;if(weeklyPlanLower_(m.recipientEmail)===recipient){m.readAt=new Date().toISOString();found=true;}else if(weeklyPlanLower_(m.recipientEmail)===BEAT_SUPPORT_ADMIN_POOL&&(m.eligibleRecipients||[]).map(weeklyPlanLower_).indexOf(recipient)>=0){m.dismissedBy=m.dismissedBy||[];if(m.dismissedBy.map(weeklyPlanLower_).indexOf(recipient)<0)m.dismissedBy.push(recipient);found=true;}});if(found)beatSupportWrite_(store);}finally{try{lock.releaseLock();}catch(ignore){}}return {ok:found};
}

/** Restricted audit dashboard: only the real Super/Admin account or the CEO
 * of the requested cluster can read it. View-as-KAM never grants access. */
function getBeatActivityTracker(selectedDate,viewer,clusterOverride) {
  try{setViewer_(viewer||'');setClusterOverride_(clusterOverride||'');setViewAsKam_('');}catch(ignore){}
  var actual=weeklyPlanLower_(viewer);if(!actual)try{actual=weeklyPlanLower_(Session.getActiveUser().getEmail());}catch(ignore2){}
  var resolved={};try{resolved=resolveViewer_(actual,clusterOverride||'')||{};}catch(ignore3){}
  var access={};try{access=getUserContext()||{};}catch(ignore4){}
  var role=weeklyPlanLower_(resolved.role),isAdmin=isSuperUser_(actual)||!!access.actualIsAdmin,isCeo=role==='ceo';
  if(!isAdmin&&!isCeo)throw new Error('Eye on KAM is available only to Admin and the cluster CEO.');
  var cluster=String(clusterOverride||resolved.cluster||'');
  if(isCeo&&!weeklyPlanClusterMatch_(cluster,resolved.cluster))throw new Error('This cluster is outside your CEO access.');
  var date=weeklyPlanDate_(selectedDate||new Date()),store=beatActivityRead_(),events=(store.events||[]).filter(function(e){return String(e.timestamp||'').slice(0,10)===date&&weeklyPlanClusterMatch_(e.cluster,cluster);});
  var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),plans=sheet.getLastRow()<2?[]:sheet.getDataRange().getValues().slice(1).map(weeklyPlanObject_).filter(function(p){return p.meetingDate===date&&weeklyPlanClusterMatch_(p.cluster,cluster);});
  var kams={};
  function ensure(email){email=weeklyPlanLower_(email)||'unassigned';if(!kams[email])kams[email]={email:email,name:weeklyPlanDisplayName_(email),planned:0,completed:0,pending:0,started:0,lastAction:'',lastSeen:'',currentMerchant:'',latitude:null,longitude:null};return kams[email];}
  plans.forEach(function(p){var k=ensure(p.kamEmail),closed=['met','closed'].indexOf(weeklyPlanLower_(p.status))>=0||!!p.meetingEndedAt;k.planned++;if(closed)k.completed++;else k.pending++;if(p.meetingStartedAt&&!p.meetingEndedAt){k.started++;k.currentMerchant=p.restaurant;}});
  events.sort(function(a,b){return String(a.timestamp).localeCompare(String(b.timestamp));}).forEach(function(e){var k=ensure(e.kamEmail);k.lastAction=e.action;k.lastSeen=e.timestamp;if(e.restaurant)k.currentMerchant=e.restaurant;if(e.latitude!==null&&e.latitude!==undefined&&e.longitude!==null&&e.longitude!==undefined){k.latitude=e.latitude;k.longitude=e.longitude;}if(e.action==='meeting_completed')k.currentMerchant='';});
  var list=Object.keys(kams).map(function(key){var k=kams[key];k.adherence=k.planned?Math.round(k.completed*100/k.planned):0;k.live=!!k.currentMerchant&&k.lastAction!=='meeting_completed';return k;}).sort(function(a,b){return Number(b.live)-Number(a.live)||b.pending-a.pending||a.name.localeCompare(b.name);});
  return {ok:true,date:date,cluster:cluster,kams:list,events:events.slice().reverse().slice(0,250),summary:{kams:list.length,planned:plans.length,completed:plans.filter(function(p){return ['met','closed'].indexOf(weeklyPlanLower_(p.status))>=0||!!p.meetingEndedAt;}).length,live:list.filter(function(k){return k.live;}).length,actions:events.length}};
}
function logBeatActivityEvent(action,meta,viewer,clusterOverride,viewAsKam) {
  var allowed=['plan_built','plan_viewed','weekly_map_opened','day_map_opened','deck_created','talking_points_opened'];
  if(allowed.indexOf(String(action||''))<0)throw new Error('Unsupported activity event.');
  var user=weeklyPlanUser_(viewer,clusterOverride,viewAsKam),m=meta||{};
  m.kamEmail=user.email;m.cluster=user.cluster;beatActivityLog_(action,user,m);return {ok:true};
}

// New per-cluster file names (same in every cluster folder; relational on res_id)
// New per-cluster file BASE names. Actual files are {base}_{clusterKey}_DD_MM.csv,
// newest date wins. clusterKey = city_cluster lowercased, spaces/+/- -> '_'.
const NOV_FILE   = { day:'Nov_day', week:'Nov_week', month:'Nov_month', quarter:'Nov_quarter' };
const TABLE_CUR_FILE = 'current_month';   // current month till-date table
const TABLE_WEEK_FILE = 'current_week';   // weekly operational table; Time_Period = YYYY-WW
const TABLE_LAST_FILE = 'last_month';     // last WHOLE month (MoM)
const TABLE_2MONTH_FILE = '2_month';      // 2 months ago (Mo2M)
const TABLE_3MONTH_FILE = '3_month';      // 3 months ago (Mo3M)
const AMTL_FILE  = 'amtl';
const PARITY_LEAD_FILE = 'price_parity_lead_list';
const CHALO_FILE = 'chalo_49';
const ADS_FILE   = 'ads';
const ADS_PLAN_FILE = 'ads_planing';  // dedicated Ads/CV lead-list CSV

// DriveApp cannot convert a very large CSV blob to text in one Apps Script
// execution (it throws "exceeds the maximum file size").  Keep every loader
// below that platform ceiling so an optional weekly feed can never halt the
// entire dashboard. Super Core should use its compact *_super feed.
const MAX_CSV_TEXT_READ_BYTES = 45 * 1024 * 1024;

// Data-retention policy for dated CSV uploads. We keep the newest three
// versions of each known file type inside every mapped cluster folder. Older
// versions go to Drive Trash (never permanently deleted by this script).
const CSV_VERSIONS_TO_KEEP = 3;
const MANAGED_CSV_BASES = [
  'price_parity_lead_list', 'ads_planing', 'current_month', 'current_week',
  'last_month', 'chalo_49', 'Nov_quarter', 'Nov_month', 'Nov_week', 'Nov_day',
  '2_month', '3_month', 'amtl', 'ads'
];

// ---------------------------------------------------------------------------
// AHMEDABAD DRIVE JSON CACHE
// ---------------------------------------------------------------------------
// Large CSVs remain the source of truth. The first request after an upload
// parses them once, scopes the result to one KAM, and writes a JSON cache in
// the same Ahmedabad folder. Source file id + modified time + size form the
// invalidation signature, so a new CSV upload can never reuse stale data.
function ahmedabadCacheSafe_(value) {
  return String(value||'all').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') || 'all';
}
function ahmedabadCacheFolder_() { return DriveApp.getFolderById(AHMEDABAD_DATA_FOLDER_ID); }
function ahmedabadCacheName_(kind,email) { return AHMEDABAD_JSON_CACHE_PREFIX+ahmedabadCacheSafe_(kind)+'_'+ahmedabadCacheSafe_(email)+'.json'; }
function ahmedabadPlanStoreName_(email) { return AHMEDABAD_PLAN_STORE_PREFIX+ahmedabadCacheSafe_(email)+'.json'; }

// -------------------------------------------------------------------------
// JSON-FIRST DUAL PLAN STORE
// -------------------------------------------------------------------------
// Each KAM owns one bounded JSON file. This is the source of truth for every
// Beat Plan mutation. The same state is mirrored to the shared control Sheet
// for audit, recovery and human visibility; app reads continue to use JSON.
function ahmedabadReadPlanStore_(email) {
  email=weeklyPlanLower_(email);if(!email)return [];
  try {
    var it=ahmedabadCacheFolder_().getFilesByName(ahmedabadPlanStoreName_(email));
    if(!it.hasNext())return [];
    var parsed=JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
    return parsed&&Array.isArray(parsed.rows)?parsed.rows:[];
  } catch(e){Logger.log('Ahmedabad plan-store read failed: '+e);return [];}
}
function ahmedabadWritePlanStore_(email,rows) {
  email=weeklyPlanLower_(email);if(!email)throw new Error('Plan store needs a KAM email.');
  rows=(rows||[]).filter(function(row){return weeklyPlanLower_(row&&row[3])===email;});
  var now=new Date(),body=JSON.stringify({version:1,cluster:'Ahmedabad',owner:email,revision:now.getTime()+'-'+Utilities.getUuid().slice(0,8),updatedAt:now.toISOString(),rows:rows});
  if(Utilities.newBlob(body).getBytes().length>AHMEDABAD_JSON_MAX_BYTES)throw new Error('This KAM plan JSON exceeded 28 MB. Close/archive older plan history before continuing.');
  var folder=ahmedabadCacheFolder_(),name=ahmedabadPlanStoreName_(email),it=folder.getFilesByName(name),file=it.hasNext()?it.next():null;
  if(file)file.setContent(body);else folder.createFile(name,body,MimeType.PLAIN_TEXT);
  while(it.hasNext())it.next().setTrashed(true);
  return true;
}
function ahmedabadDeletePlanStore_(email) {
  var it=ahmedabadCacheFolder_().getFilesByName(ahmedabadPlanStoreName_(email)),count=0;
  while(it.hasNext()){it.next().setTrashed(true);count++;}return count;
}
function ahmedabadAllPlanRows_() {
  var rows=[],it=ahmedabadCacheFolder_().getFiles();
  while(it.hasNext()){
    var file=it.next(),name=String(file.getName()||'');
    if(name.indexOf(AHMEDABAD_PLAN_STORE_PREFIX)!==0||name.slice(-5)!=='.json')continue;
    try {var parsed=JSON.parse(file.getBlob().getDataAsString('UTF-8'));if(parsed&&Array.isArray(parsed.rows))rows=rows.concat(parsed.rows);} catch(ignore) {}
  }
  return rows;
}

var __BEAT_PLAN_MIRROR_SHEET=null,__BEAT_PLAN_MIRROR_ROWS=null;
function beatPlanMirrorSheet_() {
  if(__BEAT_PLAN_MIRROR_SHEET)return __BEAT_PLAN_MIRROR_SHEET;
  var book=beatControlBook_(),sheet=book.getSheetByName(BEAT_PLAN_MIRROR_SHEET_);
  if(!sheet)sheet=book.insertSheet(BEAT_PLAN_MIRROR_SHEET_);
  if(sheet.getMaxColumns()<WEEKLY_PLAN_HEADERS_.length)sheet.insertColumnsAfter(sheet.getMaxColumns(),WEEKLY_PLAN_HEADERS_.length-sheet.getMaxColumns());
  if(sheet.getLastRow()<1){sheet.getRange(1,1,1,WEEKLY_PLAN_HEADERS_.length).setValues([WEEKLY_PLAN_HEADERS_]);beatStyleControlHeader_(sheet,WEEKLY_PLAN_HEADERS_.length);sheet.setFrozenColumns(7);}
  __BEAT_PLAN_MIRROR_SHEET=sheet;return sheet;
}
function beatPlanRowSignature_(row){return JSON.stringify((row||[]).map(function(v){return v instanceof Date?v.toISOString():v===undefined?'':v;}));}
function ahmedabadMirrorPlanStore_(email,rows) {
  email=weeklyPlanLower_(email);if(!email)return;
  var sheet=beatPlanMirrorSheet_(),all=__BEAT_PLAN_MIRROR_ROWS||sheet.getDataRange().getValues(),wanted={};
  (rows||[]).forEach(function(row){var id=String(row&&row[0]||'');if(id)wanted[id]=row;});
  var deleteRows=[];for(var i=1;i<all.length;i++)if(weeklyPlanLower_(all[i][3])===email&&!wanted[String(all[i][0]||'')])deleteRows.push(i+1);
  deleteRows.sort(function(a,b){return b-a;}).forEach(function(rowNo){sheet.deleteRow(rowNo);});
  if(deleteRows.length)all=sheet.getDataRange().getValues();
  var existing={};for(var j=1;j<all.length;j++)if(weeklyPlanLower_(all[j][3])===email)existing[String(all[j][0]||'')]={rowNo:j+1,row:all[j]};
  Object.keys(wanted).forEach(function(id){var row=wanted[id].slice();while(row.length<WEEKLY_PLAN_HEADERS_.length)row.push('');if(row.length>WEEKLY_PLAN_HEADERS_.length)row=row.slice(0,WEEKLY_PLAN_HEADERS_.length);var old=existing[id];if(old){if(beatPlanRowSignature_(old.row)!==beatPlanRowSignature_(row)){sheet.getRange(old.rowNo,1,1,WEEKLY_PLAN_HEADERS_.length).setValues([row]);all[old.rowNo-1]=row;}}else{sheet.appendRow(row);all.push(row);}});
  __BEAT_PLAN_MIRROR_ROWS=all;
}
function syncBeatPlanBackendMirror(viewer) {
  beatAssertLogicAdmin_(viewer);var all=ahmedabadAllPlanRows_(),emails={};all.forEach(function(r){var e=weeklyPlanLower_(r[3]);if(e)emails[e]=true;});Object.keys(emails).forEach(function(email){ahmedabadMirrorPlanStore_(email,all.filter(function(r){return weeklyPlanLower_(r[3])===email;}));});return {ok:true,kams:Object.keys(emails).length,rows:all.length,sheetUrl:'https://docs.google.com/spreadsheets/d/'+BEAT_CONTROL_BOOK_ID_+'/edit#gid='+beatPlanMirrorSheet_().getSheetId()};
}

// Sheet-compatible facade used by the existing stable business logic. Its
// methods read/write the KAM JSON files and mirror each committed mutation.
var __AHMEDABAD_PLAN_SHEET_ADAPTER=null;
function ahmedabadPlanSheetAdapter_() {
  if(__AHMEDABAD_PLAN_SHEET_ADAPTER)return __AHMEDABAD_PLAN_SHEET_ADAPTER;
  var data=[WEEKLY_PLAN_HEADERS_.slice()].concat(ahmedabadAllPlanRows_());
  function clone_(value){return JSON.parse(JSON.stringify(value));}
  function saveEmails_(emails){
    var unique={};(emails||[]).forEach(function(e){e=weeklyPlanLower_(e);if(e)unique[e]=true;});
    Object.keys(unique).forEach(function(email){var owned=data.slice(1).filter(function(row){return weeklyPlanLower_(row[3])===email;});ahmedabadWritePlanStore_(email,owned);try{ahmedabadMirrorPlanStore_(email,owned);}catch(mirrorError){Logger.log('Beat Plan Sheet mirror failed for '+email+': '+mirrorError);}});
  }
  function range_(row,col,numRows,numCols){
    row=Math.max(1,Number(row)||1);col=Math.max(1,Number(col)||1);numRows=Math.max(1,Number(numRows)||1);numCols=Math.max(1,Number(numCols)||1);
    var api={
      getValues:function(){var out=[];for(var r=0;r<numRows;r++){var src=data[row-1+r]||[],line=[];for(var c=0;c<numCols;c++)line.push(src[col-1+c]===undefined?'':src[col-1+c]);out.push(line);}return clone_(out);},
      setValues:function(values){var dirty=[];for(var r=0;r<numRows;r++){var at=row-1+r;if(!data[at])data[at]=[];if(at>0)dirty.push(data[at][3]);for(var c=0;c<numCols;c++)data[at][col-1+c]=values[r]&&values[r][c]!==undefined?values[r][c]:'';if(at>0)dirty.push(data[at][3]);}saveEmails_(dirty);return api;},
      setValue:function(value){return api.setValues([[value]]);},
      setNumberFormat:function(){return api;},setFontWeight:function(){return api;},setBackground:function(){return api;},setFontColor:function(){return api;}
    };return api;
  }
  __AHMEDABAD_PLAN_SHEET_ADAPTER={
    getName:function(){return WEEKLY_PLAN_SHEET_;},getLastRow:function(){return data.length;},getLastColumn:function(){return WEEKLY_PLAN_HEADERS_.length;},setFrozenRows:function(){return this;},
    getDataRange:function(){return {getValues:function(){return clone_(data);}};},getRange:range_,
    appendRow:function(record){record=clone_(record||[]);while(record.length<WEEKLY_PLAN_HEADERS_.length)record.push('');data.push(record);saveEmails_([record[3]]);return this;},
    deleteRow:function(rowNo){rowNo=Number(rowNo)||0;if(rowNo<=1||rowNo>data.length)throw new Error('Invalid plan row.');var old=data.splice(rowNo-1,1)[0];saveEmails_([old&&old[3]]);return this;}
  };
  return __AHMEDABAD_PLAN_SHEET_ADAPTER;
}
var __AHMEDABAD_SOURCE_FILES_CACHE = null;
function ahmedabadSourceFiles_() {
  if(__AHMEDABAD_SOURCE_FILES_CACHE)return __AHMEDABAD_SOURCE_FILES_CACHE;
  var out=[],it=ahmedabadCacheFolder_().getFiles();
  while(it.hasNext()){
    var f=it.next(),name=String(f.getName()||''),low=name.toLowerCase();
    if(low.slice(-4)!=='.csv')continue;
    out.push({id:f.getId(),name:name,low:low,updated:f.getLastUpdated().getTime(),size:Number(f.getSize()||0)});
  }
  __AHMEDABAD_SOURCE_FILES_CACHE=out;
  return out;
}
function ahmedabadLatestMeta_(base) {
  var b=String(base||'').toLowerCase(),best=null;
  ahmedabadSourceFiles_().forEach(function(f){if((f.low===b+'.csv'||f.low.indexOf(b+'_')===0)&&(!best||f.updated>best.updated))best=f;});
  return best?{id:best.id,name:best.name,updated:best.updated,size:best.size}:null;
}
function ahmedabadSourceSignature_(bases) {
  var parts={version:AHMEDABAD_JSON_CACHE_VERSION};
  (bases||[]).forEach(function(base){parts[String(base).toLowerCase()]=ahmedabadLatestMeta_(base);});
  return JSON.stringify(parts);
}
function ahmedabadReadJsonCache_(kind,email,signature) {
  try {
    var it=ahmedabadCacheFolder_().getFilesByName(ahmedabadCacheName_(kind,email));if(!it.hasNext())return null;
    var parsed=JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
    if(!parsed||parsed.version!==AHMEDABAD_JSON_CACHE_VERSION||String(parsed.signature||'')!==String(signature||''))return null;
    return parsed.payload||null;
  } catch(e){return null;}
}
function ahmedabadInvalidateJsonCache_(kind,email) {
  try {
    var it=ahmedabadCacheFolder_().getFilesByName(ahmedabadCacheName_(kind,email)),count=0;
    while(it.hasNext()){it.next().setTrashed(true);count++;}
    return count;
  } catch(e){Logger.log('Ahmedabad JSON cache invalidation failed: '+e);return 0;}
}
function ahmedabadWriteJsonCache_(kind,email,signature,payload) {
  try {
    var folder=ahmedabadCacheFolder_(),name=ahmedabadCacheName_(kind,email),now=new Date(),body=JSON.stringify({version:AHMEDABAD_JSON_CACHE_VERSION,cluster:'Ahmedabad',kind:kind,owner:String(email||''),signature:String(signature||''),generationId:now.getTime()+'-'+Utilities.getUuid().slice(0,8),generatedAt:now.toISOString(),payload:payload});
    // Leave very large payloads uncached instead of risking an Apps Script
    // blob/write failure. A KAM-level beat cache should normally be far below.
    if(Utilities.newBlob(body).getBytes().length>AHMEDABAD_JSON_MAX_BYTES)return false;
    var it=folder.getFilesByName(name),file=it.hasNext()?it.next():null;
    if(file)file.setContent(body);else folder.createFile(name,body,MimeType.PLAIN_TEXT);
    while(it.hasNext())it.next().setTrashed(true); // retain one current cache file
    return true;
  } catch(e){Logger.log('Ahmedabad JSON cache write failed: '+e);return false;}
}
function ahmedabadWritePlanSnapshot_(user,weekStart,dates,plans,team) {
  // Plan rows are already committed immediately by the JSON sheet adapter.
  // Keep this legacy hook as a no-op so existing API flows remain stable.
  return !!(user&&user.email);
}
function ahmedabadReadPlanSnapshot_(user,weekStart){
  // No secondary schedule cache: bootstrap always reads the authoritative
  // per-KAM plan-store JSON through weeklyPlanScopedRows_.
  return null;
}

/**
 * Safe maintenance reset for the Ahmedabad pilot.
 *
 * The per-KAM Drive JSON is the source of truth. Run this function from the
 * Apps Script editor with the KAM email to remove that KAM's untouched/open
 * AUTOMATIC plan rows directly from that JSON. Manual meetings and completed
 * history rows are kept.
 */
function resetAhmedabadOpenBeatPlan(kamEmail) {
  var actual='';try{actual=weeklyPlanLower_(Session.getActiveUser().getEmail());}catch(ignore){}
  var target=weeklyPlanLower_(kamEmail||actual);
  if(!target)throw new Error('Pass the KAM email, for example resetAhmedabadOpenBeatPlan("kam@zomato.com").');
  if(actual!==target&&!isSuperUser_(actual))throw new Error('Only the same KAM or a super admin can reset this open plan.');
  var lock=LockService.getScriptLock(),removed=0,keptProtected=0;
  try {
    lock.waitLock(20000);
    var sheet=weeklyPlanBook_().getSheetByName(WEEKLY_PLAN_SHEET_),rows=sheet.getDataRange().getValues(),remove=[];
    for(var r=1;r<rows.length;r++){
      if(weeklyPlanLower_(rows[r][3])!==target)continue;
      var automatic=weeklyPlanLower_(rows[r][18])==='automatic',status=weeklyPlanLower_(rows[r][15]||'planned');
      var untouched=!rows[r][17]&&!rows[r][29]&&!rows[r][30]&&!rows[r][34]&&!rows[r][35]&&!rows[r][36]&&!rows[r][39]&&!rows[r][40];
      var open=['planned','follow-up','no-show','reschedule requested'].indexOf(status)>=0;
      if(automatic&&open&&untouched)remove.push(r+1);else keptProtected++;
    }
    remove.sort(function(a,b){return b-a;}).forEach(function(rowNo){sheet.deleteRow(rowNo);removed++;});
    var legacyScheduleFiles=ahmedabadInvalidateJsonCache_('schedule',target),portfolioFiles=ahmedabadInvalidateJsonCache_('portfolio',target);
    return {ok:true,kamEmail:target,removedOpenAutomaticRows:removed,keptProtectedRows:keptProtected,legacyScheduleJsonRemoved:legacyScheduleFiles,portfolioCacheRemoved:portfolioFiles,planStore:ahmedabadPlanStoreName_(target),message:'Open automatic plan rows were removed directly from the authoritative KAM JSON. Refresh, then use Build Beat Plan when a fresh plan is required.'};
  } finally {try{lock.releaseLock();}catch(ignoreLock){}}
}

// Apps Script's Run button cannot pass function arguments. For an admin reset,
// set Script Property AHMEDABAD_RESET_KAM_EMAIL to the required KAM email and
// run this no-argument wrapper once. The property is removed after success so
// the same KAM cannot be reset accidentally on a later run.
function resetConfiguredAhmedabadOpenBeatPlan() {
  var props=PropertiesService.getScriptProperties(),email=weeklyPlanLower_(props.getProperty('AHMEDABAD_RESET_KAM_EMAIL'));
  if(!email)throw new Error('Add Script Property AHMEDABAD_RESET_KAM_EMAIL with the KAM email, then run again.');
  var result=resetAhmedabadOpenBeatPlan(email);
  props.deleteProperty('AHMEDABAD_RESET_KAM_EMAIL');
  return result;
}

/** Run once from the Apps Script editor after pasting this backend. It parses
 * the current Ahmedabad sources and creates compact KAM-wise JSON files in
 * the Ahmedabad folder. Future uploads invalidate these caches automatically. */
function warmAhmedabadBeatPlanCache() {
  __AHMEDABAD_SOURCE_FILES_CACHE=null;__MASTER_CACHE=null;__AMTL_MEMO=null;
  var kams=uniq_(loadMaster_().map(function(row){return weeklyPlanLower_(row.kam_email);}).filter(Boolean));
  if(!kams.length)throw new Error('No Ahmedabad KAM is mapped in the master sheet.');
  var first=weeklyPlanSourceRows_(kams[0],'Ahmedabad');
  return {ok:true,cluster:'Ahmedabad',mappedKams:kams.length,seedKam:kams[0],portfolioRows:first.rows.length,novRows:first.novRows.length,folderId:AHMEDABAD_DATA_FOLDER_ID};
}

// Super Core folder naming is intentionally not identical for every file.
// Examples (DD_M is the refresh date):
//   current_month_super_DD_M.csv, last_month_super_DD_M.csv,
//   2_month_DD_M.csv, nov_day_super_DD_M.csv,
//   price_parity_lead_list_DD_M.csv, Chalo_49_super_DD_M.csv
// Keep this map as the single source of truth whenever the Super Admin feed is
// renamed; the normal cluster folder continues to use the unsuffixed base.
const SUPER_CORE_FILE_BASES = {
  'current_month': 'current_month_super',
  'current_week': 'current_week_super',
  'last_month': 'last_month_super',
  '2_month': '2_month',
  '3_month': '3_month',
  'Nov_day': 'nov_day_super',
  'Nov_week': 'nov_week_super',
  'Nov_month': 'nov_month_super',
  'Nov_quarter': 'nov_quarter_super',
  'price_parity_lead_list': 'price_parity_lead_list',
  'chalo_49': 'chalo_49_super'
};

/**
 * Return the managed data folders only: every unique cluster folder from the
 * master mapping plus Super Core. Lead-list, tracker, and unrelated folders
 * are deliberately never included in this cleanup.
 */
function managedCsvFolders_() {
  var seen = {}, out = [];
  function add_(id, label) {
    id = String(id || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    try { out.push({ id:id, label:label || id, folder:DriveApp.getFolderById(id) }); } catch(e) {}
  }
  loadMaster_().forEach(function(r){ add_(r.folder_id, r.city_cluster); });
  add_(superAdminFolderId_(), 'Super Core');
  return out;
}

// Match only explicitly managed CSV prefixes. Longest first prevents `ads`
// from accidentally capturing `ads_planing` as a separate group.
function managedCsvBase_(fileName) {
  var low = String(fileName || '').trim().toLowerCase();
  if (!/\.csv$/i.test(low)) return '';
  var bases = MANAGED_CSV_BASES.concat(Object.keys(SUPER_CORE_FILE_BASES).map(function(k){ return SUPER_CORE_FILE_BASES[k]; }))
    .filter(Boolean).map(function(x){ return String(x).toLowerCase(); })
    .sort(function(a,b){ return b.length - a.length; });
  for (var i=0; i<bases.length; i++) {
    var base = bases[i];
    if (low === base + '.csv' || low.indexOf(base + '_') === 0) return base;
  }
  return '';
}

/**
 * Safe CSV retention job. Retains the newest `keepVersions` files for every
 * known base name in every mapped data folder, moving older versions to Trash.
 * Run `previewCsvRetentionCleanup()` first if you want a no-write report.
 */
function cleanupCsvRetention_(keepVersions, dryRun) {
  keepVersions = Math.max(1, Math.floor(Number(keepVersions) || CSV_VERSIONS_TO_KEEP));
  var report = { status:'OK', dryRun:!!dryRun, keepVersions:keepVersions, folders:0, inspected:0, trashed:[], errors:[] };
  managedCsvFolders_().forEach(function(info){
    report.folders++;
    var groups = {};
    try {
      var it = info.folder.getFiles();
      while (it.hasNext()) {
        var file = it.next();
        var base = managedCsvBase_(file.getName());
        if (!base) continue;
        report.inspected++;
        if (!groups[base]) groups[base] = [];
        groups[base].push(file);
      }
      Object.keys(groups).forEach(function(base){
        groups[base].sort(function(a,b){ return b.getLastUpdated().getTime() - a.getLastUpdated().getTime(); });
        groups[base].slice(keepVersions).forEach(function(file){
          var entry = { folder:info.label, base:base, name:file.getName(), updated:file.getLastUpdated() };
          try {
            if (!dryRun) file.setTrashed(true);
            report.trashed.push(entry);
          } catch(e) { report.errors.push({ folder:info.label, name:file.getName(), error:String(e && e.message || e) }); }
        });
      });
    } catch(e) { report.errors.push({ folder:info.label, error:String(e && e.message || e) }); }
  });
  Logger.log(JSON.stringify(report));
  return report;
}

// Manual functions shown in the Apps Script Run menu.
function previewCsvRetentionCleanup() { return cleanupCsvRetention_(CSV_VERSIONS_TO_KEEP, true); }
function runCsvRetentionCleanup() { return cleanupCsvRetention_(CSV_VERSIONS_TO_KEEP, false); }

// Install once. It removes only this job's prior triggers, then schedules a
// weekly Monday-morning cleanup. The trigger runs as the installing account.
function installWeeklyCsvRetentionCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'runCsvRetentionCleanup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runCsvRetentionCleanup').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  return 'Weekly CSV retention cleanup installed: Monday around 03:00. Keeping ' + CSV_VERSIONS_TO_KEEP + ' versions per file type.';
}

// A weekly lead list must be reusable within the same reporting week, but it
// must never return the previous week's Sheet after the Time_Period advances.
function activeWeekPeriod_(email, clusterOverride, period) {
  if (period !== 'week' && period !== 'lastweek') return '';
  try {
    var f = readForViewer_(email, TABLE_WEEK_FILE, clusterOverride);
    if (!f) return '';
    function wk_(r) { return String(r.Time_Period || r.time_period || '').trim(); }
    function serial_(v) { var m = String(v||'').match(/^(\d{4})-(\d{1,2})$/); return m ? (+m[1]*100 + +m[2]) : -1; }
    var periods = uniq_(csvToObjects_(f.csv).map(wk_).filter(function(v){ return serial_(v) >= 0; }))
      .sort(function(a,b){ return serial_(b)-serial_(a); });
    return periods[period === 'lastweek' ? 1 : 0] || '';
  } catch(e) { return ''; }
}

// cluster name -> file suffix key
function clusterKey_(cityCluster) {
  return String(cityCluster||'').trim().toLowerCase()
    .replace(/\s*\+\s*/g, '_')     // '+' -> _
    .replace(/\s*-\s*/g, '_')      // ' - ' -> _
    .replace(/\s+/g, '_')          // spaces -> _
    .replace(/_+/g, '_')           // collapse doubles
    .replace(/^_|_$/g, '');
}

// cache the parsed master for the life of one execution
var __MASTER_CACHE = null;

/** Read + parse the master mapping sheet (by ID) into cluster rows. */
function loadMaster_() {
  if (__MASTER_CACHE) return __MASTER_CACHE;
  var rows = [];
  try {
    var ss = null;
    try { ss = SpreadsheetApp.openById(MASTER_SHEET_ID); } catch (e1) { ss = null; }
    if (!ss) {
      // fallback: find the first sheet in the master folder
      var folder = DriveApp.getFolderById(MASTER_FOLDER_ID);
      var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
      if (it.hasNext()) ss = SpreadsheetApp.open(it.next());
    }
    if (ss) {
      var sh = ss.getSheetByName(MASTER_SHEET_NAME) || ss.getSheets()[0];
      var values = sh.getDataRange().getValues();
      var head = values.shift().map(function(h){ return String(h||'').trim().toLowerCase(); });
      var ci = function(){ for (var a=0;a<arguments.length;a++){ var k=head.indexOf(arguments[a]); if(k!==-1) return k; } return -1; };
      var iCC = ci('city_cluster','city cluster'),
          iF  = ci('folder_id','folder id','folder link','folderid'),
          iCeo= ci('ceo_email','ceo email'),
          iZh = ci('tl_email','zh_email','tl email','zh email'),
          iKam= ci('kam_email','kam email'),
          iP1 = ci('plus 1','plus1','plus_1'), iP2=ci('plus 2','plus2','plus_2'), iP3=ci('plus 3','plus3','plus_3'),
          iLat= ci('lat','office_latitude','office latitude'), iLng=ci('long','lng','office_longitude','office longitude');
      values.forEach(function(r){
        var cc = String(r[iCC]||'').trim();
        if (!cc || cc.toLowerCase().indexOf('ahmedabad')===-1) return;
        rows.push({
          city_cluster: cc,
          // Ahmedabad pilot has one controlled source folder. Ignore stale or
          // missing folder links in individual master rows.
          folder_id: AHMEDABAD_DATA_FOLDER_ID,
          ceo_email: String(iCeo!==-1 ? r[iCeo] : '').trim().toLowerCase(),
          zh_email:  String(iZh!==-1 ? r[iZh] : '').trim().toLowerCase(),   // holds tl_email in the new sheet
          kam_email: String(iKam!==-1 ? r[iKam] : '').trim().toLowerCase(),
          plus1_email:String(iP1!==-1?r[iP1]:'').trim().toLowerCase(),plus2_email:String(iP2!==-1?r[iP2]:'').trim().toLowerCase(),plus3_email:String(iP3!==-1?r[iP3]:'').trim().toLowerCase(),
          office_latitude:weeklyPlanLatitude_(iLat!==-1?r[iLat]:''),office_longitude:weeklyPlanLongitude_(iLng!==-1?r[iLng]:'')
        });
      });
    }
  } catch (e) { /* leave rows empty */ }
  __MASTER_CACHE = rows;
  return rows;
}

// Accept either a bare folder ID or a full Drive URL and return the ID.
function extractFolderId_(v) {
  v = String(v||'').trim();
  if (!v) return '';
  var m = v.match(/[-\w]{25,}/);   // Drive IDs are long alphanumeric/underscore/hyphen
  return m ? m[0] : v;
}

// Resolve the Super Admin folder: prefer a "Super Admin" row in the master
// sheet, else the hardcoded constant.
function superAdminFolderId_() {
  try {
    var rows = loadMaster_();
    var sa = rows.filter(function(r){
      var c = r.city_cluster.toLowerCase();
      return c === 'super admin' || c === 'super core admin' || c === 'super_core_admin';
    })[0];
    if (sa && sa.folder_id) return sa.folder_id;
  } catch (e) {}
  return SUPERADMIN_FOLDER_ID;
}

/**
 * Resolve the viewer to a routing context. Super-core admins may pass an
 * optional clusterOverride (from the top dropdown) to view a specific cluster;
 * default 'super_core_admin' reads the SuperAdmin folder (KAM-level, no res).
 *   { role, cluster, clusterKey, folderId, email, resView, kams, zhs, isSuper }
 */
function resolveViewer_(email, clusterOverride) {
  email = String(email||'').trim().toLowerCase();
  var isSuper = isSuperUser_(email);

  // A CEO / Super Core Admin can deliberately preview one mapped KAM or ZH/TL
  // dashboard from Settings.  This is an in-memory request flag only — it is
  // never stored in Properties — and it is validated against the master map
  // before any folder or portfolio is returned.
  var previewKam = String(typeof __VIEW_AS_KAM !== 'undefined' ? __VIEW_AS_KAM : '').trim().toLowerCase();
  if (previewKam) {
    var preview = resolvePreviewKam_(email, clusterOverride, previewKam);
    if (preview) return preview;
  }

  if (isSuper) {
    var ov = String(clusterOverride||'').trim();
    if (!ov || ov === 'super_core_admin' || ov.toLowerCase() === 'all') {
      return { role:'super', cluster:'Super Core Admin', clusterKey:'super_core_admin',
               folderId:superAdminFolderId_(), email:email, resView:false, kams:[], zhs:[], isSuper:true };
    }
    // super picked a specific cluster -> read that cluster's folder, full res view
    var rowsS = loadMaster_();
    var match = rowsS.filter(function(r){ return r.city_cluster === ov || clusterKey_(r.city_cluster) === clusterKey_(ov); });
    if (match.length) {
      return { role:'ceo', cluster:match[0].city_cluster, clusterKey:clusterKey_(match[0].city_cluster),
               folderId:match[0].folder_id, email:email, resView:true,
               kams: uniq_(match.map(function(r){return r.kam_email;})),
               zhs:  uniq_(match.map(function(r){return r.zh_email;})), isSuper:true };
    }
    // unknown override -> fall back to super
    return { role:'super', cluster:'Super Core Admin', clusterKey:'super_core_admin',
             folderId:superAdminFolderId_(), email:email, resView:false, kams:[], zhs:[], isSuper:true };
  }

  var rows = loadMaster_();
  var plusRows=rows.filter(function(r){return [r.plus1_email,r.plus2_email,r.plus3_email].indexOf(email)>=0;});
  if(plusRows.length){var pr=plusRows[0];return {role:'ceo',cluster:pr.city_cluster,clusterKey:clusterKey_(pr.city_cluster),folderId:pr.folder_id,email:email,resView:true,kams:uniq_(plusRows.map(function(r){return r.kam_email;})),zhs:uniq_(plusRows.map(function(r){return r.zh_email;})),isSuper:false,isPlus:true,officeLatitude:pr.office_latitude,officeLongitude:pr.office_longitude};}
  // A Core member may grant a person full admin access to one dashboard
  // cluster. It behaves like that cluster's CEO view only; it never unlocks
  // Super Core or another cluster.
  var manualClusters = clusterAdminClusters_(email);
  if (manualClusters.length) {
    var wantedCluster = String(clusterOverride || '').trim();
    var chosenCluster = manualClusters.filter(function(c){
      return wantedCluster && (c === wantedCluster || clusterKey_(c) === clusterKey_(wantedCluster));
    })[0] || manualClusters[0];
    var adminRows = rows.filter(function(r){ return r.city_cluster === chosenCluster || clusterKey_(r.city_cluster) === clusterKey_(chosenCluster); });
    if (adminRows.length) {
      return { role:'ceo', cluster:adminRows[0].city_cluster, clusterKey:clusterKey_(adminRows[0].city_cluster),
               folderId:adminRows[0].folder_id, email:email, resView:true,
               kams:uniq_(adminRows.map(function(r){ return r.kam_email; })),
               zhs:uniq_(adminRows.map(function(r){ return r.zh_email; })), isSuper:false, isClusterAdmin:true };
    }
  }
  var ceoRows = rows.filter(function(r){ return r.ceo_email === email; });
  if (ceoRows.length) {
    // multi-cluster CEO can switch clusters via the override
    var ov2 = String(clusterOverride||'').trim();
    var pick = ceoRows;
    if (ov2 && ov2 !== 'super_core_admin') {
      var sub = ceoRows.filter(function(r){ return r.city_cluster === ov2 || clusterKey_(r.city_cluster) === clusterKey_(ov2); });
      if (sub.length) pick = sub;
    }
    return { role:'ceo', cluster:pick[0].city_cluster, clusterKey:clusterKey_(pick[0].city_cluster),
             folderId:pick[0].folder_id, email:email, resView:true,
             kams: uniq_(pick.map(function(r){return r.kam_email;})),
             zhs:  uniq_(pick.map(function(r){return r.zh_email;})), isSuper:false };
  }
  var zhRows = rows.filter(function(r){ return r.zh_email === email; });
  if (zhRows.length) {
    return { role:'zh', cluster:zhRows[0].city_cluster, clusterKey:clusterKey_(zhRows[0].city_cluster),
             folderId:zhRows[0].folder_id, email:email, resView:true,
             kams: uniq_(zhRows.map(function(r){return r.kam_email;})), zhs:[email], isSuper:false };
  }
  var kamRow = rows.filter(function(r){ return r.kam_email === email; })[0];
  if (kamRow) {
    return { role:'kam', cluster:kamRow.city_cluster, clusterKey:clusterKey_(kamRow.city_cluster),
             folderId:kamRow.folder_id, email:email, resView:true, kams:[email], zhs:[kamRow.zh_email], isSuper:false };
  }
  return { role:'unknown', cluster:'', clusterKey:'', folderId:'', email:email, resView:false, kams:[], zhs:[], isSuper:false };
}

// Return a KAM-only routing context when an authorised CEO / Super Core Admin
// chooses "View as KAM".  A Super user must first choose a real cluster; a CEO
// can only choose KAMs in a cluster assigned to that CEO.  This prevents a
// browser-provided email from being used to view an unrelated portfolio.
function resolvePreviewKam_(actualEmail, clusterOverride, kamEmail) {
  actualEmail = String(actualEmail||'').trim().toLowerCase();
  kamEmail = String(kamEmail||'').trim().toLowerCase();
  if (!actualEmail || !kamEmail) return null;
  var ov = String(clusterOverride||'').trim();
  if (!ov || ov === 'super_core_admin' || ov.toLowerCase() === 'all') return null;
  var rows = loadMaster_().filter(function(r){
    var sameCluster = r.city_cluster === ov || clusterKey_(r.city_cluster) === clusterKey_(ov);
    return sameCluster && (String(r.kam_email||'').toLowerCase() === kamEmail || String(r.zh_email||'').toLowerCase() === kamEmail);
  });
  if (!rows.length) return null;
  var row = rows[0];
  var allowed = isSuperUser_(actualEmail) || String(row.ceo_email||'').toLowerCase() === actualEmail || [row.plus1_email,row.plus2_email,row.plus3_email].indexOf(actualEmail)>=0;
  if (!allowed) return null;
  var isZh = rows.some(function(r){ return String(r.zh_email||'').toLowerCase() === kamEmail; });
  if (isZh) {
    var team = rows.filter(function(r){ return String(r.zh_email||'').toLowerCase() === kamEmail; });
    return {
      role:'zh', cluster:row.city_cluster, clusterKey:clusterKey_(row.city_cluster),
      folderId:row.folder_id, email:kamEmail, resView:true,
      kams:uniq_(team.map(function(r){ return r.kam_email; })), zhs:[kamEmail], isSuper:false,
      actualEmail:actualEmail, viewAsKam:kamEmail, viewAsRole:'zh'
    };
  }
  return {
    role:'kam', cluster:row.city_cluster, clusterKey:clusterKey_(row.city_cluster),
    folderId:row.folder_id, email:kamEmail, resView:true, kams:[kamEmail],
    zhs:row.zh_email ? [row.zh_email] : [], isSuper:false,
    actualEmail:actualEmail, viewAsKam:kamEmail
  };
}

// The default Super Core folder is a KAM-level scorecard feed, not a
// restaurant-level portfolio.  A Super user who chooses a concrete cluster is
// no longer in this mode and can use the normal detailed lead-list flow.
function isSuperCoreFolder_(rv, clusterOverride) {
  var ov = String(clusterOverride || '').trim().toLowerCase();
  return !!rv && rv.role === 'super' && (!ov || ov === 'super_core_admin' || ov === 'all');
}

function uniq_(arr){ var s={},o=[]; arr.forEach(function(x){ if(x && !s[x]){s[x]=1;o.push(x);} }); return o; }

// True if this email is mapped anywhere in the master sheet (as ceo/tl/kam) OR
// is a super user. Access is granted on MAPPING, not on whether the person's
// name happens to appear in the day's data — CEOs & core team have full rights
// even if they own no restaurants directly.
function isMappedInMaster_(email) {
  email = String(email||'').trim().toLowerCase();
  if (!email) return false;
  if (isSuperUser_(email)) return true;
  try {
    var rows = loadMaster_();
    for (var i=0;i<rows.length;i++){
      var r = rows[i];
      if (r.ceo_email === email || r.zh_email === email || r.kam_email === email || r.plus1_email===email || r.plus2_email===email || r.plus3_email===email) return true;
    }
  } catch (e) {}
  return false;
}

/** List all clusters (for the super-core dropdown). */
function getClusterList(viewer) {
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  if (!isSuperUser_(email)) return { status:'DENY', clusters:[] };
  var rows = loadMaster_();
  var seen = {}, out = [];
  rows.forEach(function(r){
    var c = r.city_cluster;
    var lc = c.toLowerCase();
    if (lc === 'super admin' || lc === 'super core admin' || lc === 'super_core_admin') return;
    if (c && !seen[c]){ seen[c]=1; out.push(c); }
  });
  out.sort();
  return { status:'OK', clusters: out, isSuper:true };
}

/**
 * Settings-only KAM preview picker.  Super users can choose any mapped
 * cluster; CEOs can choose only their own cluster(s).  The returned KAM list
 * is always restricted to the requested allowed cluster.
 */
function getViewAsKamOptions(viewer, clusterOverride, audience) {
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var isSuper = isSuperUser_(email);
  var clusters = isSuper ? getClusterList(email).clusters : ceoClusters_(email);
  if (!isSuper && !clusters.length) return { status:'FORBIDDEN', clusters:[], kams:[], zhs:[] };

  var wanted = String(clusterOverride||'').trim();
  if (!wanted || wanted === 'super_core_admin') wanted = clusters[0] || '';
  var allowedCluster = clusters.filter(function(c){ return c === wanted || clusterKey_(c) === clusterKey_(wanted); })[0] || '';
  if (!allowedCluster) return { status:'FORBIDDEN', clusters:clusters, kams:[], zhs:[] };

  var kams = uniq_(loadMaster_().filter(function(r){
    return r.city_cluster === allowedCluster || clusterKey_(r.city_cluster) === clusterKey_(allowedCluster);
  }).map(function(r){ return String(r.kam_email||'').trim().toLowerCase(); }).filter(Boolean)).sort();
  var zhs = uniq_(loadMaster_().filter(function(r){
    return r.city_cluster === allowedCluster || clusterKey_(r.city_cluster) === clusterKey_(allowedCluster);
  }).map(function(r){ return String(r.zh_email||'').trim().toLowerCase(); }).filter(Boolean)).sort();
  return { status:'OK', clusters:clusters, selectedCluster:allowedCluster, kams:kams, zhs:zhs, people:String(audience||'').toLowerCase()==='zh' ? zhs : kams, isSuper:isSuper };
}

/** Clusters a non-super CEO/Plus user owns. */
function ceoClusters_(email) {
  email = String(email||'').trim().toLowerCase();
  var rows = loadMaster_();
  var seen = {}, out = [];
  rows.forEach(function(r){
    if ([weeklyPlanLower_(r.ceo_email),weeklyPlanLower_(r.plus1_email),weeklyPlanLower_(r.plus2_email),weeklyPlanLower_(r.plus3_email)].indexOf(email)<0) return;
    var c = r.city_cluster;
    var lc = String(c||'').toLowerCase();
    if (lc === 'super admin' || lc === 'super core admin' || lc === 'super_core_admin') return;
    if (c && !seen[c]){ seen[c]=1; out.push(c); }
  });
  out.sort();
  return out;
}

/** Get the Drive folder for the viewer's cluster (respects super override). */
function clusterFolder_(email, clusterOverride) {
  var rv = resolveViewer_(email, clusterOverride);
  if (!rv.folderId) return null;
  try { return DriveApp.getFolderById(rv.folderId); } catch (e) { return null; }
}

/**
 * Read the newest cluster CSV matching the base name. Files live INSIDE the
 * cluster's own folder, so there is NO cluster suffix — names are just
 * {base}_DD_MM.csv (e.g. current_month_28_07.csv) or plain {base}.csv.
 * The clusterKey arg is accepted for signature compatibility but ignored.
 */
function readClusterFile_(folder, base, clusterKey) {
  if (!folder) return null;
  var b = String(base||'').toLowerCase();
  var best = null, bestTime = 0;
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var low = String(f.getName()||'').toLowerCase();
    if (low.slice(-4) !== '.csv') continue;
    // match {base}.csv or {base}_<anything>.csv  (e.g. current_month_28_07.csv)
    var ok = low === b + '.csv' || low.indexOf(b + '_') === 0;
    if (ok) { var t = f.getLastUpdated().getTime(); if (t > bestTime) { bestTime = t; best = f; } }
  }
  if (!best) return null;
  // A regular res-level file can be much larger than the Super Core KAM feed.
  // Do not call getBlob() for it: Apps Script throws before our caller can
  // recover, taking down getAllPeriods and the complete dashboard with it.
  try {
    if (Number(best.getSize()) > MAX_CSV_TEXT_READ_BYTES) return null;
  } catch (sizeErr) { return null; }
  var blob = best.getBlob(), csv;
  try { csv = blob.getDataAsString('UTF-8'); }
  catch (e) {
    try { csv = blob.getDataAsString(); }
    catch (readErr) { return null; }
  }
  return { name: best.getName(), csv: csv, fileDate: best.getLastUpdated().toISOString() };
}

// Return the expected Super Core base first, followed by backward-compatible
// alternatives.  This covers the supplied Super Admin folder exactly while
// still allowing an older upload to work during a transition.
function superCoreFileCandidates_(base) {
  var raw = String(base || '');
  var mapped = SUPER_CORE_FILE_BASES[raw] || SUPER_CORE_FILE_BASES[Object.keys(SUPER_CORE_FILE_BASES).filter(function(k){ return k.toLowerCase() === raw.toLowerCase(); })[0]];
  return uniq_([mapped, raw + '_super', raw]);
}

function readSuperCoreFile_(folder, base, clusterKey) {
  var candidates = superCoreFileCandidates_(base);
  for (var i = 0; i < candidates.length; i++) {
    var hit = readClusterFile_(folder, candidates[i], clusterKey);
    if (hit) return hit;
  }
  return null;
}

/** Convenience: read a cluster file for the current viewer (with override). */
function readForViewer_(email, base, clusterOverride) {
  var rv = resolveViewer_(email, clusterOverride);
  var folder = clusterFolder_(email, clusterOverride);
  // Super Core uses the explicit file map above; it includes a few deliberately
  // unsuffixed files such as 2_month and price_parity_lead_list.
  var superCore = rv.isSuper && (!clusterOverride || clusterOverride === '' || clusterOverride === 'super_core_admin');
  if (superCore) {
    var hitS = readSuperCoreFile_(folder, base, rv.clusterKey);
    if (hitS) return hitS;
  }
  return readClusterFile_(folder, base, rv.clusterKey);
}

/** Parse AMTL (charter,city_cluster,res_id,res_name,subzone_name,city_name,am_email,tl_email,primary_cuisine,tier)
 *  into res_id -> mapping. AMTL is the relational spine: res_name/city/am/tl come from here. */
function loadAmtl_(email, clusterOverride) {
  var out = {};
  var signature=ahmedabadSourceSignature_([AMTL_FILE]);
  var cached=ahmedabadReadJsonCache_('amtl','all',signature);
  if(cached&&cached.map)return cached.map;
  var f = readForViewer_(email, AMTL_FILE, clusterOverride);
  if (!f) return out;
  csvToObjects_(f.csv).forEach(function(r){
    // AMTL is maintained manually and its headers have varied in case/spacing.
    // Resolve every field through the same normalised lookup used by exports.
    var rid = normId_(rawLeadValue_(r,['res_id','res id','restaurant_id']));
    if (!rid) return;
    out[rid] = {
      am_email: String(rawLeadValue_(r,['am_email','kam_email'])||'').trim().toLowerCase(),
      tl_email: String(rawLeadValue_(r,['tl_email','zh_email'])||'').trim().toLowerCase(),
      city: rawLeadValue_(r,['city_name','city'])||'',
      tier: rawLeadValue_(r,['tier','tier_name','restaurant_tier'])||'',
      cuisine: rawLeadValue_(r,['primary_cuisine','cuisine'])||'',
      res_name: rawLeadValue_(r,['res_name','res name','restaurant_name'])||'',
      subzone: rawLeadValue_(r,['subzone_name','subzone'])||'',
      cluster: rawLeadValue_(r,['city_cluster','cluster'])||'', charter: rawLeadValue_(r,['charter'])||'',
      mid: String(rawLeadValue_(r,['mid','merchant_id','merchant id'])||'').trim(),
      chain_id: String(rawLeadValue_(r,['chain_id','chain id','chainid'])||'').trim(),
      latitude: weeklyPlanLatitude_(rawLeadValue_(r,['res_latitude','res latitude','latitude','lat'])),
      longitude: weeklyPlanLongitude_(rawLeadValue_(r,['res_longitude','res longitude','longitude','lng','lon']))
    };
  });
  ahmedabadWriteJsonCache_('amtl','all',signature,{map:out,count:Object.keys(out).length});
  return out;
}

// Normalise a res_id for joining: string, trimmed, drop a trailing ".0" that
// float CSV exports sometimes add (123456.0 -> 123456).
function normId_(v) {
  var s = String(v==null?'':v).trim();
  s = s.replace(/\.0+$/, '');
  return s;
}

// Per-execution AMTL cache (res details are the source of truth, any date).
var __AMTL_MEMO = null;
function amtlMap_() {
  if (__AMTL_MEMO) return __AMTL_MEMO;
  __AMTL_MEMO = loadAmtl_(__VIEWER_EMAIL || getCurrentEmail_(),
                          (typeof __CLUSTER_OVERRIDE !== 'undefined') ? __CLUSTER_OVERRIDE : '');
  return __AMTL_MEMO;
}

/**
 * Enrich parsed NOV/table rows with restaurant details from AMTL (by res_id).
 * AMTL is the master for res_name / city / cuisine / am / tl — so we always
 * prefer AMTL values and only keep the row's own value when AMTL lacks it.
 */
function enrichRowsFromAmtl_(rows) {
  if (!rows || !rows.length) return rows;
  // Super-core data is cluster-level (no res_id) — AMTL join doesn't apply.
  var rv = resolveViewer_(__VIEWER_EMAIL || getCurrentEmail_(), __CLUSTER_OVERRIDE);
  var superCore = rv.isSuper && (!__CLUSTER_OVERRIDE || __CLUSTER_OVERRIDE === '' || __CLUSTER_OVERRIDE === 'super_core_admin');
  if (superCore) return rows;
  var amtl = amtlMap_();
  rows.forEach(function(r){
    var a = amtl[normId_(r.resId)];
    if (!a) return;
    if (a.res_name) { r.restaurant = a.res_name; }
    // city/cuisine: the NOV file now carries these — keep the row's own value,
    // only fall back to AMTL when the row is blank/Unknown.
    if (a.city && (!r.city || r.city === 'Unknown')) { r.city = a.city; }
    if (a.cuisine && (!r.cuisine || r.cuisine === 'N/A')) { r.cuisine = a.cuisine; }
    // am/tl: fill from AMTL only when the row lacks them (don't override real owner data)
    if (a.am_email && (!r.am || r.am === 'n/a' || r.am === 'N/A')) { r.am = a.am_email; }
    if (a.tl_email && (!r.tl || r.tl === 'n/a' || r.tl === 'N/A')) { r.tl = a.tl_email; }
    if (a.cluster)  { r.cluster = a.cluster; }
    if (a.subzone)  { r.subzone = a.subzone; }
  });
  return rows;
}

/** Generic CSV -> array of row objects keyed by header (trimmed). */
function csvToObjects_(csv) {
  if (!csv) return [];
  var lines = String(csv).replace(/^\uFEFF/, '').replace(/\r/g,'').split('\n').filter(function(l){ return l.length; });
  if (!lines.length) return [];
  var rawHead = splitCsvLine_(lines.shift()).map(function(h){ return String(h||'').replace(/^\uFEFF/, '').trim(); });
  return lines.map(function(line){
    var cells = splitCsvLine_(line);
    var o = {};
    for (var i=0;i<rawHead.length;i++) {
      var val = cells[i] !== undefined ? cells[i] : '';
      o[rawHead[i]] = val;                       // original header
      var lk = rawHead[i].toLowerCase();
      if (o[lk] === undefined) o[lk] = val;       // lowercased alias
      var lk2 = lk.replace(/\s+/g,'_');           // "Res id" -> "res_id"
      if (o[lk2] === undefined) o[lk2] = val;
    }
    // New deep-dive files keep several established operational columns in
    // JSON cells. Flatten them into the same row only when a direct column is
    // absent, so every existing target card / lead-list calculation continues
    // to read `actual_mvd_sv`, `intended_mvd_sv`, etc. without a rewrite.
    function putJson_(key, value) {
      if (value === undefined || value === null) return;
      var rawKey = String(key), lower = rawKey.toLowerCase(), snake = lower.replace(/\s+/g,'_');
      if (o[rawKey] === undefined || o[rawKey] === '') o[rawKey] = value;
      if (o[lower] === undefined || o[lower] === '') o[lower] = value;
      if (o[snake] === undefined || o[snake] === '') o[snake] = value;
    }
    ['status_json','visibility_json','hygiene_json','pg_orders_json','nrl_orders_json','mealtime_orders_json','funnel_metrics_json','refund_json','merchent_discount','merchant_discount','share','ads_metrics'].forEach(function(jsonCol){
      var raw = o[jsonCol];
      if (!raw) return;
      try {
        var parsed = JSON.parse(String(raw));
        if (parsed && typeof parsed === 'object') Object.keys(parsed).forEach(function(key){ putJson_(key, parsed[key]); });
      } catch (ignore) {}
    });
    return o;
  });
}

// Preserve the business CSV's visible column order for lead-list exports.
// csvToObjects_ also creates lowercase aliases for flexible lookups; those
// aliases are intentionally excluded from the exported workbook headers.
function csvSourceHeaders_(csv) {
  var lines = String(csv||'').replace(/^\uFEFF/, '').replace(/\r/g,'').split('\n').filter(function(l){ return l.length; });
  if (!lines.length) return [];
  return splitCsvLine_(lines[0]).map(function(h){ return String(h||'').replace(/^\uFEFF/, '').trim(); }).filter(Boolean);
}

/** CSV line splitter that respects double quotes. */
function splitCsvLine_(line) {
  var out = [], cur = '', q = false;
  for (var i=0;i<line.length;i++) {
    var c = line[i];
    if (c === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === ',' && !q) { out.push(cur); cur=''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function num_(v){ var n = parseFloat(String(v||'').replace(/[, %]/g,'')); return isFinite(n) ? n : 0; }
// Source files have used both intended_m_share and intended_merchant_share
// (and occasionally the "merchent" spelling). Treat all of them as one
// intended merchant-share metric for MVD/SV, Salt and ZVD lead lists.
function intendedMshare_(row) {
  row = row || {};
  var aliases = ['intended_merchant_share','intended_merchent_share','intended_m_share','intended_mshare',
                 'intended_merchant_share_pct','intended_m_share_pct','intended_mshare_pct'];
  for (var i=0;i<aliases.length;i++) {
    var v = row[aliases[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return num_(v);
  }
  // Flexible fallback for small header spelling/spacing changes.
  var keys = Object.keys(row);
  for (var j=0;j<keys.length;j++) {
    var key = String(keys[j]).toLowerCase().replace(/[^a-z0-9]/g,'');
    if (key.indexOf('intended') === 0 && (key.indexOf('merchantshare') !== -1 || key.indexOf('merchentshare') !== -1 || key.indexOf('mshare') !== -1)) {
      var value = row[keys[j]];
      if (value !== undefined && value !== null && String(value).trim() !== '') return num_(value);
    }
  }
  return 0;
}
function isPe_(v){ var s = String(v||'').trim().toLowerCase(); return s==='1'||s==='pe'||s==='yes'||s==='true'||s==='live'; }

/**
 * ===========================================================================
 * PHASE 1 CORE: getNovBucketsV2
 * Reads table_<period> from the viewer's cluster folder, scopes rows by role
 * via AMTL, and returns the NOV + CM lever boxes. No "count of res" headline —
 * each box carries the meaningful aggregate plus its own lead rows.
 * ===========================================================================
 */
// Lightweight aggregate of the box-level metrics for a set of table rows.
// Used to compute apple-to-apple MoM / Mo2M comparisons per lever card.
// scopeFn(r) decides whether a row is in the viewer's scope.
function computeBoxAggs_(rows, scopeFn) {
  var t = { orders:0, sv:0, cv:0, ad:0, actualMvd:0, commRev:0, zvd:0, salt:0,
            visCount:0, saltCount:0, mvdCount:0, pcCount:0, zvdCount:0, commCount:0, notActive:0, refund:0 };
  (rows||[]).forEach(function(r){
    if (scopeFn && !scopeFn(r)) return;
    // Supply-value denominator consistently includes packaging charges.
    var sv = num_(r.sv) + num_(r.packaging_charges), cv = num_(r.commissionable_value), ad = num_(r.ad_rev);
    var intMvdPct = num_(r.intended_mvd_sv), actualMvdPct = num_(r.actual_mvd_sv);
    if (actualMvdPct > 0 && actualMvdPct <= 1) actualMvdPct *= 100;
    if (!actualMvdPct && sv > 0) actualMvdPct = num_(r.mvd) / sv * 100;
    t.orders += num_(r.total_orders); t.sv += sv; t.cv += cv; t.ad += ad; t.actualMvd += sv*actualMvdPct/100;
    t.commRev += num_(r.commission_revenue); t.zvd += num_(r.zvd); t.salt += num_(r.salt);
    var exp = num_(r.expected), act = num_(r.actual);
    if (exp > 0 && (act/exp*100) < 95) t.visCount++;
    if (sv > 0 && (num_(r.salt)/sv*100) < 1) t.saltCount++;
    if (intMvdPct > 0 && actualMvdPct < intMvdPct) t.mvdCount++;
    var ords = num_(r.total_orders);
    if (ords > 0 && sv > 0) { var asv = sv/ords; if (asv>0 && (num_(r.packaging_charges)/ords)/asv*100 > 10) t.pcCount++; }
    if (sv > 0 && num_(r.zvd) > 0 && (num_(r.zvd)/sv*100) > 5) t.zvdCount++;
    if (ords > 0 && num_(r.commission_revenue) === 0) t.commCount++;
    if (ords === 0) t.notActive++;
    // Refund is a value lever, not a restaurant-count lever.  The operational
    // metric is refund cost per order: merchant + customer refund / total orders.
    t.refund += num_(r.mx_refund) + num_(r.cx_refund);
  });
  return {
    mvdsv:      t.sv>0 ? +(t.actualMvd/t.sv*100).toFixed(2) : 0,
    saltsv:     t.sv>0 ? +(t.salt/t.sv*100).toFixed(2) : 0,
    zvdsv:      t.sv>0 ? +(t.zvd/t.sv*100).toFixed(2) : 0,
    adscv:      t.cv>0 ? +(t.ad/t.cv*100).toFixed(2) : 0,
    commValue:  t.cv>0 ? +(t.commRev/t.cv*100).toFixed(2) : 0,
    visibility: t.visCount, salt: t.saltCount, mvdCount: t.mvdCount, notActive:t.notActive,
    refund: t.orders>0 ? +(t.refund/t.orders).toFixed(2) : 0,
    pc: t.pcCount, zvd: t.zvdCount
  };
}

function getNovBucketsV2(period, viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride);
  email = String(rv.email || email).toLowerCase();
  var superCore = isSuperCoreFolder_(rv, clusterOverride);
  if (['day','week','month','quarter','lastweek','lastmonth'].indexOf(period) === -1) period = 'month';

  // Last Month is a true historical operating view: its M is the completed
  // last_month table and LM is the table before that.  There is deliberately
  // no L2M in this mode, so users never compare a completed month to an
  // unnecessary third period. Week views use one current_week file whose
  // Time_Period values identify the latest M, LW, L2W and L3W snapshots.
  var isLastMonth = period === 'lastmonth';
  var isWeeklyMode = period === 'week' || period === 'lastweek';
  var mTable = isWeeklyMode ? TABLE_WEEK_FILE : (isLastMonth ? TABLE_LAST_FILE : TABLE_CUR_FILE);
  var lmTable = isWeeklyMode ? TABLE_WEEK_FILE : (isLastMonth ? TABLE_2MONTH_FILE : TABLE_LAST_FILE);
  var l2mTable = isWeeklyMode ? TABLE_WEEK_FILE : (isLastMonth ? '' : TABLE_2MONTH_FILE);
  var tf = readForViewer_(email, mTable, clusterOverride);
  if (!tf) return { status:'NO_DATA', period:period, role:rv.role, cluster:rv.cluster };

  var sourceRows = csvToObjects_(tf.csv);
  var weeklyRows = { m:[], last:[], mo2:[], mo3:[] }, selectedWeek = '';
  if (isWeeklyMode) {
    // YYYY-WW is sorted numerically, not lexically, so both 2026-7 and
    // 2026-07 are handled correctly. Last Week starts from the prior bucket.
    function weekPeriod_(r) { return String(r.Time_Period || r.time_period || '').trim(); }
    function weekSerial_(v) {
      var m = String(v||'').match(/^(\d{4})-(\d{1,2})$/);
      return m ? (+m[1] * 100 + +m[2]) : -1;
    }
    var weekPeriods = uniq_(sourceRows.map(weekPeriod_).filter(function(v){ return weekSerial_(v) >= 0; }))
      .sort(function(a,b){ return weekSerial_(b) - weekSerial_(a); });
    var offset = period === 'lastweek' ? 1 : 0;
    selectedWeek = weekPeriods[offset] || '';
    if (!selectedWeek) return { status:'NO_DATA', period:period, role:rv.role, cluster:rv.cluster,
                                message:'No valid Time_Period (YYYY-WW) found in current_week.' };
    function rowsForWeek_(index) {
      var key = weekPeriods[index] || '';
      return key ? sourceRows.filter(function(r){ return weekPeriod_(r) === key; }) : [];
    }
    weeklyRows.m = rowsForWeek_(offset);
    weeklyRows.last = rowsForWeek_(offset + 1);
    weeklyRows.mo2 = rowsForWeek_(offset + 2);
    weeklyRows.mo3 = rowsForWeek_(offset + 3);
  }
  var rows = isWeeklyMode ? weeklyRows.m : sourceRows;
  var amtl = loadAmtl_(email, clusterOverride);

  function inScope(r){
    if (rv.role === 'super' || rv.role === 'ceo') return true;
    var am = String(r.am_email||'').trim().toLowerCase();
    var tl = String(r.tl_email||'').trim().toLowerCase();
    var amtlId = normId_(r.res_id);
    if ((!am || !tl) && amtl[amtlId]) {
      var a = amtl[amtlId];
      am = am || a.am_email; tl = tl || a.tl_email;
    }
    if (rv.role === 'kam') return am === email || tl === email;
    if (rv.role === 'zh')  return rv.kams.indexOf(am) !== -1 || tl === email;
    return true;
  }

  var kam = {};
  function K(k){ if(!kam[k]) kam[k] = { sv:0, cv:0, adRev:0, commRev:0, zvd:0, salt:0, refund:0,
      pe_sv:0, pe_mvd:0, npe_sv:0, npe_mvd:0, actualMvd:0 }; return kam[k]; }

  // Prior completed period Order_Makes (for "Not Active Res" comparisons).
  var lastOM = {};
  try {
    var lastOrderRows = isWeeklyMode ? weeklyRows.last : (function(){
      var lf = readForViewer_(email, lmTable, clusterOverride);
      return lf ? csvToObjects_(lf.csv) : [];
    })();
    lastOrderRows.forEach(function(r){
      var id = String(r.res_id||'').trim(); if (id) lastOM[id] = num_(r.Order_Makes || r.order_makes);
    });
  } catch (e) {}

  var leads = { visibility:[], salt:[], mvdsv:[], adscv:[], notActive:[], commValue:[], zvdsv:[], pc:[], refund:[] };

  // Restaurant-level historical values for the MVD/SV and Salt lead lists.
  // In Last Month view history.last is the month before the selected month;
  // history.mo2 stays empty by design. Weekly mode always exposes four
  // snapshots: M, LW, L2W and L3W.
  var history = { last:{}, mo2:{}, mo3:{} };
  function loadHistory_(base, into, suppliedRows) {
    try {
      var historyRows = suppliedRows;
      if (!historyRows) {
        var f = readForViewer_(email, base, clusterOverride);
        if (!f) return;
        historyRows = csvToObjects_(f.csv);
      }
      historyRows.forEach(function(r){
        if (!inScope(r)) return;
        var id = String(r.res_id||'').trim(), svh = num_(r.sv);
        if (!id) return;
        var mh = num_(r.actual_mvd_sv); if (mh>0 && mh<=1) mh *= 100;
        if (!mh && svh>0) { mh = num_(r.mvd)/svh*100; }
        var expectedH = num_(r.expected), visibleH = expectedH > 0 ? +(num_(r.actual)/expectedH*100).toFixed(2) : 0;
        into[id] = { mvd:+(mh||0).toFixed(2), salt:svh>0 ? +(num_(r.salt)/svh*100).toFixed(2) : 0,
                     zvd:svh>0 ? +(num_(r.zvd)/svh*100).toFixed(2) : 0,
                     visibility:visibleH, orders:num_(r.total_orders) };
      });
    } catch(e) {}
  }
  loadHistory_(lmTable, history.last, isWeeklyMode ? weeklyRows.last : null);
  if (l2mTable) loadHistory_(l2mTable, history.mo2, isWeeklyMode ? weeklyRows.mo2 : null);
  if (isWeeklyMode) loadHistory_(TABLE_WEEK_FILE, history.mo3, weeklyRows.mo3);

  // Commission Revenue performance is commission_revenue / commissionable_value.
  // Benchmark every restaurant against its own KAM portfolio's weighted rate,
  // never against absolute ₹ commissionable value.
  var commRateByKam = {}, totalOrdersScope = 0, peers = {}, cityOrders = {}, portfolioOrders = {};
  // Ads coverage is deliberately based on the requested operational rule:
  // ad_rev > 1000.  It is kept separately from Ads/CV so both KPIs are clear.
  var adsCoverage = { eligibleRes:0, totalRes:0, eligibleCv:0, totalCv:0 };
  rows.forEach(function(r){
    if (!inScope(r)) return;
    var a0 = amtl[normId_(r.res_id)] || {};
    var k0 = String(r.am_email||a0.am_email||'').trim().toLowerCase();
    if (!commRateByKam[k0]) commRateByKam[k0] = { cv:0, commission:0 };
    commRateByKam[k0].cv += num_(r.commissionable_value);
    commRateByKam[k0].commission += num_(r.commission_revenue);
    adsCoverage.totalRes++;
    adsCoverage.totalCv += num_(r.commissionable_value);
    if (num_(r.ad_rev) > 1000) {
      adsCoverage.eligibleRes++;
      adsCoverage.eligibleCv += num_(r.commissionable_value);
    }
    var rowOrders = num_(r.total_orders);
    totalOrdersScope += rowOrders;
    var rowCity = String(r.city||a0.city||'').trim();
    var rowKam = String(r.am_email||a0.am_email||'').trim().toLowerCase();
    cityOrders[rowCity] = (cityOrders[rowCity] || 0) + rowOrders;
    portfolioOrders[rowKam] = (portfolioOrders[rowKam] || 0) + rowOrders;
    var sv0 = num_(r.sv);
    if (sv0 > 0) {
      var pk = String(r.cuisine||a0.cuisine||'Unknown').toLowerCase().trim() + '|' + String(r.city||a0.city||'Unknown').toLowerCase().trim();
      if (!peers[pk]) peers[pk] = { mvd:[], salt:[] };
      var m0 = num_(r.actual_mvd_sv); if (m0>0 && m0<=1) m0 *= 100;
      if (!m0) m0 = num_(r.mvd)/sv0*100;
      var s0 = num_(r.salt)/sv0*100;
      if (m0>0) peers[pk].mvd.push(m0);
      if (s0>0) peers[pk].salt.push(s0);
    }
  });
  function peerStats_(vals) {
    if (!vals || !vals.length) return { avg:0, max:0, n:0 };
    var sum = vals.reduce(function(s,v){ return s+v; },0);
    return { avg:+(sum/vals.length).toFixed(2), max:+Math.max.apply(null,vals).toFixed(2), n:vals.length };
  }

  rows.forEach(function(r){
    if (!inScope(r)) return;
    var rid = normId_(r.res_id);
    var a = amtl[rid] || {};
    var kamE = String(r.am_email||a.am_email||'').trim().toLowerCase();
    var base = { id:rid, name:r.res_name||a.res_name||'', city:r.city||a.city||'', tier:r.tier||a.tier||'',
                 kam:kamE, tl:String(r.tl_email||a.tl_email||'').trim().toLowerCase(),
                 cluster:rv.cluster||'', cuisine:r.cuisine||a.cuisine||'',
                 orders:num_(r.total_orders), mxRefund:num_(r.mx_refund), cxRefund:num_(r.cx_refund),
                 // City OV is the restaurant's share within this city; Portfolio
                 // OV is the restaurant's share within its mapped KAM portfolio.
                 cityOv: cityOrders[String(r.city||a.city||'').trim()]>0 ? +(num_(r.total_orders)/cityOrders[String(r.city||a.city||'').trim()]*100).toFixed(2) : 0,
                 portfolioOv: portfolioOrders[kamE]>0 ? +(num_(r.total_orders)/portfolioOrders[kamE]*100).toFixed(2) : 0,
                 orderContribution: totalOrdersScope>0 ? +(num_(r.total_orders)/totalOrdersScope*100).toFixed(2) : 0 };

    var sv = num_(r.sv), cv = num_(r.commissionable_value), ad = num_(r.ad_rev);
    var peerKey = String(base.cuisine||'Unknown').toLowerCase().trim() + '|' + String(base.city||'Unknown').toLowerCase().trim();
    var peer = peers[peerKey] || {mvd:[],salt:[]};
    var peerMvd = peerStats_(peer.mvd), peerSalt = peerStats_(peer.salt);
    // Source CSV values are already percentages (for example 5.4, not 0.054).
    var intMvdPct = num_(r.intended_mvd_sv);
    var actualMvdPct = num_(r.actual_mvd_sv);
    if (actualMvdPct > 0 && actualMvdPct <= 1) actualMvdPct *= 100;
    if (!actualMvdPct && sv > 0) actualMvdPct = num_(r.mvd) / sv * 100;
    var actualMvdAbs = sv * actualMvdPct / 100;
    var pe = isPe_(r.PE_Status);

    var k = K(kamE);
    var commRev = num_(r.commission_revenue);
    var zvdAmt = num_(r.zvd);
    var saltAmt = num_(r.salt);
    k.sv += sv; k.cv += cv; k.adRev += ad; k.actualMvd += actualMvdAbs;
    k.commRev += commRev; k.zvd += zvdAmt; k.salt += saltAmt;
    k.refund += base.mxRefund + base.cxRefund;
    if (pe) { k.pe_sv += sv; k.pe_mvd += actualMvdAbs; }
    else if (actualMvdPct > 0) { k.npe_sv += sv; k.npe_mvd += actualMvdAbs; }

    var exp = num_(r.expected), act = num_(r.actual);
    if (exp > 0) {
      var vis = act/exp*100;
      if (vis < 95) {
        var vl = mkLead_(base, +vis.toFixed(1), 95);
        vl.last=history.last[rid] ? history.last[rid].visibility : 0;
        vl.mo2=history.mo2[rid] ? history.mo2[rid].visibility : 0;
        vl.mo3=history.mo3[rid] ? history.mo3[rid].visibility : 0;
        leads.visibility.push(vl);
      }
    }
    // Salt is actionable when it is below its cuisine × city benchmark OR
    // below the account's LM/L2M high-water mark.
    if (sv > 0) {
      var ssv = saltAmt/sv*100;
      var saltLm = history.last[rid] ? history.last[rid].salt : 0;
      var saltL2m = history.mo2[rid] ? history.mo2[rid].salt : 0;
      var saltL3w = history.mo3[rid] ? history.mo3[rid].salt : 0;
      var saltBelowBenchmark = peerSalt.n >= 2 && ssv < peerSalt.avg;
      var saltHistoryBaseline = isLastMonth ? saltLm : (isWeeklyMode ? Math.max(saltLm, saltL2m, saltL3w) : Math.max(saltLm, saltL2m));
      var saltBelowHistory = saltHistoryBaseline > 0 && ssv < saltHistoryBaseline;
      if (saltBelowBenchmark || saltBelowHistory) {
        var sl = mkLead_(base, +ssv.toFixed(2), 0);
        sl.peerAvg=peerSalt.avg; sl.peerMax=peerSalt.max;
        sl.last=saltLm; sl.mo2=saltL2m; sl.mo3=saltL3w;
        sl.actionable=[];
        if (saltBelowBenchmark) sl.actionable.push('Salt lower than benchmark');
        if (saltBelowHistory) sl.actionable.push(isLastMonth ? 'Salt lower than LM' : (isWeeklyMode ? 'Salt lower than previous 3 weeks' : 'Salt lower than previous 2 months'));
        sl.actionable=sl.actionable.join(', ');
        sl.zvdSv=sv>0 ? +(zvdAmt/sv*100).toFixed(2) : 0;
        sl.peFlag=String(r.PE_Status||''); sl.intendedMvd=intMvdPct;
        sl.intendedMshare=intendedMshare_(r);
        sl.adsMinusZvd=sv>0 ? +((ad-zvdAmt)/sv*100).toFixed(2) : 0;
        leads.salt.push(sl);
      }
    }
    // Target = MAX(LM, L2M, benchmark average), with a maximum 3pp increase.
    // The action text preserves every applicable reason for the account.
    var mvdLm = history.last[rid] ? history.last[rid].mvd : 0;
    var mvdL2m = history.mo2[rid] ? history.mo2[rid].mvd : 0;
    var mvdL3w = history.mo3[rid] ? history.mo3[rid].mvd : 0;
    var mvdHistoryHigh = isLastMonth ? mvdLm : (isWeeklyMode ? Math.max(mvdLm, mvdL2m, mvdL3w) : Math.max(mvdLm, mvdL2m));
    var mvdBelowBenchmark = peerMvd.n >= 2 && actualMvdPct < peerMvd.avg;
    var mvdBelowHistory = mvdHistoryHigh > 0 && actualMvdPct < mvdHistoryHigh;
    if (mvdBelowBenchmark || mvdBelowHistory) {
      var mvdBaseTarget = Math.max(mvdHistoryHigh, mvdBelowBenchmark ? peerMvd.avg : 0);
      var mvdTarget = Math.min(mvdBaseTarget, actualMvdPct + 3);
      var ml = mkLead_(base, +actualMvdPct.toFixed(2), +mvdTarget.toFixed(2));
      ml.peerAvg=peerMvd.avg; ml.peerMax=peerMvd.max; ml.target=mvdTarget;
      ml.increase=+(mvdTarget-actualMvdPct).toFixed(2);
      ml.last=mvdLm; ml.mo2=mvdL2m; ml.mo3=mvdL3w;
      ml.actionable=[];
      if (mvdBelowBenchmark) ml.actionable.push('Below benchmark average — increase');
      if (mvdBelowHistory) ml.actionable.push(isLastMonth ? 'Below LM baseline — increase' : (isWeeklyMode ? 'Below LW/L2W/L3W baseline — increase' : 'Below LM/L2M baseline — increase'));
      ml.actionable=ml.actionable.join(', ');
      ml.zvdSv=sv>0 ? +(zvdAmt/sv*100).toFixed(2) : 0;
      ml.peFlag=String(r.PE_Status||''); ml.intendedMvd=intMvdPct;
      ml.intendedMshare=intendedMshare_(r);
      ml.adsMinusZvd=sv>0 ? +((ad-zvdAmt)/sv*100).toFixed(2) : 0;
      leads.mvdsv.push(ml);
    }
    if (cv > 0 && (ad/cv*100) < 1) leads.adscv.push(mkLead_(base, +(ad/cv*100).toFixed(2), 1));
    var ords = num_(r.total_orders);
    // Below the owning KAM portfolio's weighted Commission Revenue / CV %.
    var portfolioAvgRate = commRateByKam[kamE] && commRateByKam[kamE].cv > 0
      ? (commRateByKam[kamE].commission / commRateByKam[kamE].cv * 100) : 0;
    var commissionRate = cv > 0 ? (commRev / cv * 100) : 0;
    if (cv > 0 && portfolioAvgRate > 0 && commissionRate < portfolioAvgRate) {
      var cl = mkLead_(base, +commissionRate.toFixed(2), +portfolioAvgRate.toFixed(2));
      cl.gap = +(portfolioAvgRate - commissionRate).toFixed(2);
      leads.commValue.push(cl);
    }
    var zvd = zvdAmt;
    // ZVD/SV: include every outlet with burn. Refunds are part of burn as well.
    var refunds = base.mxRefund + base.cxRefund;
    if (sv > 0 && (zvd > 0 || refunds > 0)) {
      var zsv = zvd/sv*100;
      var zl = mkLead_(base, +zsv.toFixed(1), 5);
      zl.zvd = zvd; zl.mxRefund = base.mxRefund; zl.cxRefund = base.cxRefund;
      zl.totalBurn = zvd + refunds;
      zl.last=history.last[rid] ? history.last[rid].zvd : 0;
      zl.mo2=history.mo2[rid] ? history.mo2[rid].zvd : 0;
      zl.mo3=history.mo3[rid] ? history.mo3[rid].zvd : 0;
      zl.mvdCurrent=actualMvdPct;
      zl.actionable='Reduce ZVD/SV';
      zl.zvdSv=zsv; zl.peFlag=String(r.PE_Status||''); zl.intendedMvd=intMvdPct;
      zl.intendedMshare=intendedMshare_(r);
      zl.adsMinusZvd=sv>0 ? +((ad-zvdAmt)/sv*100).toFixed(2) : 0;
      leads.zvdsv.push(zl);
    }
    if (refunds > 0) {
      var rl = mkLead_(base, +refunds.toFixed(2), 0);
      rl.mxRefund = base.mxRefund; rl.cxRefund = base.cxRefund; rl.totalBurn = refunds;
      leads.refund.push(rl);
    }

    // Packaging Charges: avg PC per order vs 10% of ASV (avg SV per order).
    // Flag res where PC/order > 10% of (sv/order)  ==  packaging_charges > 0.10*sv.
    var pc = num_(r.packaging_charges);
    if (ords > 0 && sv > 0) {
      var asv = sv / ords;                 // avg SV per order
      var pcPerOrder = pc / ords;          // avg PC per order
      var pcPctOfAsv = asv > 0 ? (pcPerOrder / asv * 100) : 0;
      if (pcPctOfAsv > 10) leads.pc.push(mkLead_(base, +pcPctOfAsv.toFixed(1), 10));
    }

    // Not Active is strictly the current_month total_orders = 0 condition.
    // It must not include a merely declining restaurant from a prior month.
    if (ords === 0) {
      var nl = mkLead_(base, exp>0 ? +(act/exp*100).toFixed(1) : 0, lastOM[rid]||0);
      nl.lastOrders=lastOM[rid]||0; nl.mo2Orders=history.mo2[rid] ? history.mo2[rid].orders : 0;
      nl.mo3Orders=history.mo3[rid] ? history.mo3[rid].orders : 0;
      leads.notActive.push(nl);
    }
  });

  var tot = { sv:0, cv:0, adRev:0, actualMvd:0, commRev:0, zvd:0, salt:0, refund:0, pe_sv:0, pe_mvd:0, npe_sv:0, npe_mvd:0 };
  var kamList = [];
  Object.keys(kam).forEach(function(k){
    var x = kam[k];
    tot.sv+=x.sv; tot.cv+=x.cv; tot.adRev+=x.adRev; tot.actualMvd+=x.actualMvd;
    tot.commRev+=x.commRev; tot.zvd+=x.zvd; tot.salt+=x.salt; tot.refund+=x.refund;
    tot.pe_sv+=x.pe_sv; tot.pe_mvd+=x.pe_mvd; tot.npe_sv+=x.npe_sv; tot.npe_mvd+=x.npe_mvd;
    kamList.push({
      kam:k,
      mvdSv:  x.sv>0 ? +(x.actualMvd/x.sv*100).toFixed(2) : 0,
      peMvdSv: x.pe_sv>0 ? +(x.pe_mvd/x.pe_sv*100).toFixed(2) : 0,
      npeMvdSv: x.npe_sv>0 ? +(x.npe_mvd/x.npe_sv*100).toFixed(2) : 0,
      adsCv:  x.cv>0 ? +(x.adRev/x.cv*100).toFixed(2) : 0
    });
  });
  kamList.sort(function(a,b){ return a.mvdSv - b.mvdSv; });

  var mvdOverall  = tot.sv>0 ? +(tot.actualMvd/tot.sv*100).toFixed(2) : 0;
  var visibilityOrderContribution = +(leads.visibility.reduce(function(sum, x){ return sum + (x.orderContribution||0); }, 0).toFixed(2));
  var visibilityOrders = Math.round(leads.visibility.reduce(function(sum, x){ return sum + (x.orders||0); }, 0));
  var peMvdOverall = tot.pe_sv>0 ? +(tot.pe_mvd/tot.pe_sv*100).toFixed(2) : 0;
  var npeMvdOverall = tot.npe_sv>0 ? +(tot.npe_mvd/tot.npe_sv*100).toFixed(2) : 0;
  var adsOverall  = tot.cv>0 ? +(tot.adRev/tot.cv*100).toFixed(2) : 0;
  var adsCoverageSummary = {
    eligibleRes: adsCoverage.eligibleRes,
    totalRes: adsCoverage.totalRes,
    resPct: adsCoverage.totalRes>0 ? +(adsCoverage.eligibleRes/adsCoverage.totalRes*100).toFixed(1) : 0,
    eligibleCv: Math.round(adsCoverage.eligibleCv),
    totalCv: Math.round(adsCoverage.totalCv),
    cvPct: adsCoverage.totalCv>0 ? +(adsCoverage.eligibleCv/adsCoverage.totalCv*100).toFixed(1) : 0
  };
  var commValOverall = tot.cv>0 ? +(tot.commRev/tot.cv*100).toFixed(2) : 0;   // commission_revenue / commissionable_value
  var zvdSvOverall = tot.sv>0 ? +(tot.zvd/tot.sv*100).toFixed(2) : 0;          // zvd / sv
  var saltSvOverall = tot.sv>0 ? +(tot.salt/tot.sv*100).toFixed(2) : 0;        // salt / sv
  var refundPerOrderOverall = totalOrdersScope>0 ? +(tot.refund/totalOrdersScope).toFixed(2) : 0;

  var parity = readParitySummary_(email, rv, clusterOverride);
  // Keep the actual price-parity rows on the bucket as well.  The dashboard
  // summary is rolled up, but both the per-card and Overall Lead List must be
  // able to build a separate, scoped Price Parity sheet.
  var parityLeads = getParityLeads_(email, rv, clusterOverride);
  var chalo49 = getChalo49Summary_(email, rv, clusterOverride);

  // Super Core receives KAM-level source rows. Never present those as
  // restaurant flags: a distinct KAM is the operational unit in this view.
  function flaggedKamCount_(items) {
    var seen = {};
    (items || []).forEach(function(x, i){
      var k = String((x && x.kam) || '').trim().toLowerCase();
      // A malformed row must not collapse every blank KAM into one record.
      seen[k || ('row_' + i)] = 1;
    });
    return Object.keys(seen).length;
  }
  function countForView_(items) { return superCore ? flaggedKamCount_(items) : (items || []).length; }

  // ---- M/L* apple-to-apple comparison per box ----
  var scopeFn = function(r){ return inScope(r); };
  var curAgg = computeBoxAggs_(rows, scopeFn);
  var lastAgg = null, mo2Agg = null, mo3Agg = null;
  if (isWeeklyMode) {
    lastAgg = weeklyRows.last.length ? computeBoxAggs_(weeklyRows.last, scopeFn) : null;
    mo2Agg = weeklyRows.mo2.length ? computeBoxAggs_(weeklyRows.mo2, scopeFn) : null;
    mo3Agg = weeklyRows.mo3.length ? computeBoxAggs_(weeklyRows.mo3, scopeFn) : null;
  } else {
    try { var lf2 = readForViewer_(email, lmTable, clusterOverride); if (lf2) lastAgg = computeBoxAggs_(csvToObjects_(lf2.csv), scopeFn); } catch(e){}
    if (l2mTable) try { var m2f = readForViewer_(email, l2mTable, clusterOverride); if (m2f) mo2Agg = computeBoxAggs_(csvToObjects_(m2f.csv), scopeFn); } catch(e){}
  }

  // Attach M/L* values to each box; the client switches labels to LW/L2W/L3W
  // whenever the selected source is current_week.
  function cmp(key){
    return {
      cur:  curAgg  ? curAgg[key]  : null,
      last: lastAgg ? lastAgg[key] : null,
      mo2:  mo2Agg  ? mo2Agg[key]  : null,
      mo3:  mo3Agg  ? mo3Agg[key]  : null,
      weekly: isWeeklyMode
    };
  }
  var momByKey = {
    mvdsv: cmp('mvdsv'), salt: cmp('saltsv'), zvdsv: cmp('zvdsv'),
    adscv: cmp('adscv'), commValue: cmp('commValue'),
    visibility: cmp('visibility'), pc: cmp('pc'), notActive: cmp('notActive'), refund: cmp('refund')
  };

  var novBoxes = [
      { key:'notActive',  label:superCore?'Not Active KAMs':'Not Active Res', metric:countForView_(leads.notActive), unit:superCore?' kam':' res', leads:leads.notActive, hasData:true, mom:momByKey.notActive, leadDisabled:superCore },
      { key:'visibility', label:'Visibility <95%', metric:countForView_(leads.visibility), unit:superCore?' kam':' res', leads:leads.visibility, hasData:true, leadDisabled:superCore,
        orderContribution:visibilityOrderContribution, orderContributionOrders:visibilityOrders, mom:momByKey.visibility },
      { key:'mvdsv',      label:'MVD/SV',          metric:mvdOverall, unit:'%', sub:{ pe:peMvdOverall, npe:npeMvdOverall }, leads:leads.mvdsv, hasData:true, mom:momByKey.mvdsv, leadDisabled:superCore },
      { key:'salt',       label:'Salt',            metric:saltSvOverall, unit:'%', leads:leads.salt, hasData:true, mom:momByKey.salt, leadDisabled:superCore },
      // Price Disparity uses its dedicated CSV and is an active lead-list
      // workflow for every role, including Super Core.
      { key:'priceParity',label:'Price Disparity', metric:(parity?parity.avgOvContribution:null), unit:'%', leads:parityLeads, hasData:true },
      // The Chalo app is always available, even before today's CSV arrives.
      // Keeping this card live prevents its CTA from becoming a grey button.
      { key:'chalo49',    label:'Chalo 49',        metric:superCore?chalo49.kamCount:chalo49.count, unit:superCore?' kam':' res', leads:[], hasData:true,
        redirectUrl:'https://item-49.pages.dev/', sub:superCore?'KAMs with eligible restaurants':'eligible restaurants', leadDisabled:superCore },
      { key:'pc',         label:'Packaging (PC)', metric:null, unit:'', leads:[], hasData:false, status:'upcoming', leadDisabled:true },
      // No acquisition source/rule has been supplied: keep the card visible
      // but explicitly upcoming, without a lead-list CTA, at the end.
      { key:'acquisition',label:'Acquisition',     metric:null, unit:'', leads:[], hasData:false, status:'upcoming' }
  ];
  // Super Core is a KAM scorecard. "Not Active" is a restaurant-specific
  // operational queue, so keep it on cluster/KAM dashboards only.
  if (superCore) novBoxes = novBoxes.filter(function(b){ return b.key !== 'notActive'; });
  var valBoxes = [
      { key:'adscv',     label:'Ads/CV',                metric:adsOverall, unit:'%', leads:leads.adscv, hasData:true, coverage:adsCoverageSummary, mom:momByKey.adscv, leadDisabled:superCore },
      { key:'commValue', label:'Commission Revenue',  metric:commValOverall, unit:'%', leads:leads.commValue, hasData:true, mom:momByKey.commValue, leadDisabled:superCore },
      { key:'zvdsv',     label:'ZVD/SV',                metric:zvdSvOverall, unit:'%', leads:leads.zvdsv, hasData:true, mom:momByKey.zvdsv, leadDisabled:superCore },
      // Keep the value visible, but hold the operational queue until the
      // refund workflow is released.
      { key:'refund',    label:'Merchant & Customer Refund', metric:refundPerOrderOverall, unit:' ₹/order', leads:leads.refund, hasData:true, mom:momByKey.refund, leadUpcoming:true, leadDisabled:true }
  ];

  return {
    status:'OK', period:period, historicalMonth:isLastMonth, weeklyMode:isWeeklyMode,
    selectedWeek:selectedWeek, role:rv.role, cluster:rv.cluster,
    resView: rv.resView, superCore:superCore,
    overall: {
      mvdSv: mvdOverall, peMvdSv: peMvdOverall, npeMvdSv: npeMvdOverall,
      adsCv: adsOverall, sv: Math.round(tot.sv), cv: Math.round(tot.cv)
    },
    kamList: kamList,
    parity: parity,
    nov: novBoxes,
    val: valBoxes
  };
}

// Price-parity dashboard summary from the parity lead list file itself.
// The lead file is res+item level; we roll up to KAM: number_of_res + res_ov_contribution.
function readParitySummary_(email, rv, clusterOverride) {
  var f = readForViewer_(email, PARITY_LEAD_FILE, clusterOverride);
  if (!f) return null;
  var rows = csvToObjects_(f.csv).filter(function(r){
    var k = String(r.kam_email||'').trim().toLowerCase();
    if (rv.role === 'super' || rv.role === 'ceo') return true;
    if (rv.role === 'zh')  return rv.kams.indexOf(k) !== -1;
    if (rv.role === 'kam') return k === email;
    return false;
  });
  // per-kam: unique res + summed res_ov_contribution
  var byKam = {};
  var seenRes = {};   // kam|res
  var totalOv = 0, totalRes = 0;
  rows.forEach(function(r){
    var k = String(r.kam_email||'').trim().toLowerCase();
    var rid = String(r.res_id||'').trim();
    var ov = num_(r.res_ov_contribution);
    var pf = String(r['Priority Flag']||r.priority_flag||'').trim();
    if (!byKam[k]) byKam[k] = { kam:k, resSet:{}, ov:0, priority:{} };
    if (rid && !byKam[k].resSet[rid]) { byKam[k].resSet[rid] = 1; byKam[k].ov += ov; totalRes++; totalOv += ov; }
    if (pf) byKam[k].priority[pf] = (byKam[k].priority[pf]||0) + 1;
  });
  var perKam = Object.keys(byKam).map(function(k){
    var x = byKam[k];
    return { kam:k, number_of_res:Object.keys(x.resSet).length,
             res_ov_contribution:+x.ov.toFixed(2), priority:x.priority };
  });
  // simple average of res_ov_contribution across all flagged res, shown as %
  var avgOv = totalRes > 0 ? +(totalOv / totalRes).toFixed(2) : 0;
  return { ovContribution:+totalOv.toFixed(2), avgOvContribution: avgOv, countRes:totalRes, perKam:perKam };
}

// Return price-parity rows in the common lead-card shape.  The detailed CSV
// itself is still used when creating the per-card sheet, so no source columns
// are lost there.  This small shape lets Price Parity appear in Overall Lead
// List and in its preview just like every other card.
function getParityLeads_(email, rv, clusterOverride) {
  var f = readForViewer_(email, PARITY_LEAD_FILE, clusterOverride);
  if (!f) return [];
  return csvToObjects_(f.csv).filter(function(r){
    var k = String(r.kam_email||'').trim().toLowerCase();
    if (rv.role === 'super' || rv.role === 'ceo') return true;
    if (rv.role === 'zh') return rv.kams.indexOf(k) !== -1 || String(r.zh_email||'').trim().toLowerCase() === rv.email;
    return rv.role === 'kam' && k === email;
  }).map(function(r){
    return {
      id: String(r.res_id||''), name:String(r.res_name||r.restaurant_name||''),
      city:String(r.city_name||r.city||r.region_cluster||''),
      kam:String(r.kam_email||'').trim().toLowerCase(), cuisine:String(r.cuisine||''),
      orders:num_(r.total_orders), cmVal:num_(r.res_ov_contribution||r.res_ov), lmVal:0
    };
  });
}

// Chalo 49 is a dated CSV in the same cluster folder: chalo_49_DD_MM.csv.
// The card is intentionally count-only; its CTA opens the dedicated Chalo 49
// application instead of creating a duplicate Google Sheet.
function getChalo49Summary_(email, rv, clusterOverride) {
  var f = readForViewer_(email, CHALO_FILE, clusterOverride);
  if (!f) return { hasData:false, count:0, kamCount:0 };
  var seen = {}, seenKams = {};
  csvToObjects_(f.csv).forEach(function(r){
    var kam = String(r.kam_email||'').trim().toLowerCase();
    var zh = String(r.zh_email||'').trim().toLowerCase();
    var permitted = rv.role === 'super' || rv.role === 'ceo' ||
      (rv.role === 'zh' && (rv.kams.indexOf(kam) !== -1 || zh === rv.email)) ||
      (rv.role === 'kam' && kam === email);
    if (!permitted || num_(r.eligible_item_count) <= 0) return;
    var id = normId_(r.res_id) || String(r.res_name||'').trim().toLowerCase();
    if (id) seen[id] = 1;
    if (kam) seenKams[kam] = 1;
  });
  return { hasData:true, count:Object.keys(seen).length, kamCount:Object.keys(seenKams).length };
}

function getCurrentEmail_() {
  try { return String(Session.getActiveUser().getEmail()||'').toLowerCase(); } catch(e){ return ''; }
}

/**
 * Daily month-to-date trend for the Portfolio chart. The Day NOV file carries
 * day-wise rows (1st of month -> today) with nov_target/nov_actual/cm. The
 * table (current_month) carries operational metrics; if it is day-wise
 * (Time_Period per day) we build daily series, else a single "to date" point.
 *
 * Returns per-metric series keyed by metric:
 *   nov: [{date, target, actual}], cm: [...], orders/mvdsv/zvdsv/saltsv/adscv:
 *   [{date, value}]
 */
function getDailyTrend(viewer, clusterOverride, viewAsKam, trendPeriod, trendFilters) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride);
  email = String(rv.email || email).toLowerCase();
  trendPeriod = String(trendPeriod || 'month').toLowerCase();
  // The only day-wise feed available is current_month. Keep its granular
  // day chart for This Month; every other selected range uses its weekly
  // buckets so Last Week / Last Month never turn into a blank chart.
  var weeklyTrend = trendPeriod === 'week' || trendPeriod === 'lastweek' || trendPeriod === 'lastmonth';
  var historicalMonth = false;
  trendFilters = trendFilters || {};
  function selected_(value, values) {
    if (!values || !values.length) return true;
    var v = String(value || '').trim().toLowerCase();
    return values.indexOf(v) !== -1;
  }
  var trendFilter = {
    city:(trendFilters.city || []).map(function(v){ return String(v||'').trim().toLowerCase(); }).filter(Boolean),
    cuisine:(trendFilters.cuisine || []).map(function(v){ return String(v||'').trim().toLowerCase(); }).filter(Boolean),
    tl:(trendFilters.tl || []).map(function(v){ return String(v||'').trim().toLowerCase(); }).filter(Boolean),
    kam:(trendFilters.kam || []).map(function(v){ return String(v||'').trim().toLowerCase(); }).filter(Boolean)
  };
  var trendAmtl = loadAmtl_(email, clusterOverride);
  function matchesTrendFilter_(r) {
    var a = trendAmtl[normId_(r.res_id)] || {};
    return selected_(r.city || r.city_name || a.city, trendFilter.city) &&
      selected_(r.cuisine || r.primary_cuisine || a.cuisine, trendFilter.cuisine) &&
      selected_(r.tl_email || r.zh_email || r.tl || a.tl_email, trendFilter.tl) &&
      selected_(r.am_email || r.kam_email || r.am || a.am_email, trendFilter.kam);
  }

  function scoped(am, tl){
    if (rv.role==='super'||rv.role==='ceo') return true;
    if (rv.role==='kam') return am===email || tl===email;
    if (rv.role==='zh')  return rv.kams.indexOf(am)!==-1 || tl===email;
    return true;
  }

  // ---- NOV / CM day-wise from the Day NOV file ----
  var novByDate = {}, cmByDate = {};
  try {
    var nf = readForViewer_(email, NOV_FILE.day, clusterOverride);
    if (nf) csvToObjects_(nf.csv).forEach(function(r){
      var am=String(r.am_email||'').toLowerCase(), tl=String(r.tl_email||'').toLowerCase();
      if (!scoped(am,tl) || !matchesTrendFilter_(r)) return;
      var d = normDate_(r.period_label);
      if (!d) return;
      if (!novByDate[d]) novByDate[d] = { t:0, a:0 };
      if (!cmByDate[d])  cmByDate[d]  = { t:0, a:0 };
      novByDate[d].t += num_(r.nov_target);  novByDate[d].a += num_(r.nov_actual);
      cmByDate[d].t  += num_(r.supply_cm_target); cmByDate[d].a += num_(r.supply_cm_actual);
    });
  } catch (e) {}

  // ---- operational metrics: day-wise from the table if it has Time_Period ----
  var opByDate = {};   // date -> {orders,sv,zvd,salt,ad,cv, intMvd}
  var tableDaywise = false;
  try {
    var tf = readForViewer_(email, TABLE_CUR_FILE, clusterOverride);
    if (tf) {
      var rows = csvToObjects_(tf.csv);
      rows.forEach(function(r){
        var am=String(r.am_email||'').toLowerCase(), tl=String(r.tl_email||'').toLowerCase();
        if (!scoped(am,tl) || !matchesTrendFilter_(r)) return;
        var d = normDate_(r.Time_Period) || normDate_(r.period_label);
        var key = d || '__all__';
        if (d) tableDaywise = true;
        if (!opByDate[key]) opByDate[key] = { orders:0, sv:0, zvd:0, salt:0, ad:0, cv:0, intMvd:0 };
        var o = opByDate[key];
        var sv = num_(r.sv), intMvdPct = num_(r.intended_mvd_sv);
        o.orders += num_(r.total_orders); o.sv += sv; o.zvd += num_(r.zvd);
        o.salt += num_(r.salt); o.ad += num_(r.ad_rev); o.cv += num_(r.commissionable_value);
        o.intMvd += sv*intMvdPct/100;
      });
    }
  } catch (e) {}

  function weekStart_(iso) {
    if (!iso || iso === 'To date') return iso;
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var d = new Date(+parts[0], +parts[1]-1, +parts[2]);
    d.setDate(d.getDate() - ((d.getDay()+6)%7));
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  function groupWeek_(map) {
    var out = {};
    Object.keys(map).forEach(function(d){
      var wk = weekStart_(d), src = map[d];
      if (!out[wk]) out[wk] = {};
      Object.keys(src).forEach(function(k){ out[wk][k] = (out[wk][k] || 0) + (num_(src[k]) || 0); });
    });
    return out;
  }
  var trendNov = weeklyTrend ? groupWeek_(novByDate) : novByDate;
  var trendCm = weeklyTrend ? groupWeek_(cmByDate) : cmByDate;
  var trendOp = weeklyTrend ? groupWeek_(opByDate) : opByDate;

  function seriesTA(map){
    return Object.keys(map).sort().map(function(d){ return { date:d, target:Math.round(map[d].t), actual:Math.round(map[d].a) }; });
  }
  function seriesOp(field){
    var keys = Object.keys(trendOp).filter(function(k){ return k!=='__all__'; }).sort();
    if (!keys.length && trendOp['__all__']) keys = ['To date'];
    return keys.map(function(d){
      var o = trendOp[d] || trendOp['__all__'] || {};
      var val = 0;
      if (field==='orders') val = Math.round(o.orders||0);
      else if (field==='mvdsv') val = o.sv>0 ? +(o.intMvd/o.sv*100).toFixed(2) : 0;
      else if (field==='zvdsv') val = o.sv>0 ? +(o.zvd/o.sv*100).toFixed(2) : 0;
      else if (field==='saltsv') val = o.sv>0 ? +(o.salt/o.sv*100).toFixed(2) : 0;
      else if (field==='adscv') val = o.cv>0 ? +(o.ad/o.cv*100).toFixed(2) : 0;
      return { date:d, value:val };
    });
  }

  return {
    status:'OK',
    nov: seriesTA(trendNov),
    cm:  seriesTA(trendCm),
    orders: seriesOp('orders'),
    mvdsv: seriesOp('mvdsv'),
    zvdsv: seriesOp('zvdsv'),
    saltsv: seriesOp('saltsv'),
    adscv: seriesOp('adscv'),
    tableDaywise: tableDaywise,
    granularity: weeklyTrend ? 'week' : 'day',
    historicalMonth: historicalMonth
  };
}

// Normalise a period label / date string to YYYY-MM-DD (or '' if not a date).
function normDate_(s) {
  s = String(s||'').trim();
  if (!s) return '';
  try {
    var d = parsePeriodLabelToDate(s);
    if (d && !isNaN(d.getTime())) {
      var m = ('0'+(d.getMonth()+1)).slice(-2), day = ('0'+d.getDate()).slice(-2);
      return d.getFullYear()+'-'+m+'-'+day;
    }
  } catch (e) {}
  // try YYYY-MM-DD directly
  var m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m2) return m2[1]+'-'+('0'+m2[2]).slice(-2)+'-'+('0'+m2[3]).slice(-2);
  return '';
}

// MoM / Mo2M / Mo3M NOV+CM trend for the viewer's scope. Reads current_month +
// last_month + (when present) last2lastmonth + last3lastmonth. Absolute totals
// so the client can show a simple 3-4 point trend under the boxes.
function getMomTrend(viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride);
  email = String(rv.email || email).toLowerCase();

  function sumFile(base){
    var f = readForViewer_(email, base, clusterOverride);
    if (!f) return null;
    var rows = csvToObjects_(f.csv);
    var orders=0, cv=0, sv=0, n=0;
    rows.forEach(function(r){
      var am = String(r.am_email||'').toLowerCase(), tl = String(r.tl_email||'').toLowerCase();
      if (!(rv.role==='super'||rv.role==='ceo') ) {
        if (rv.role==='kam' && am!==email && tl!==email) return;
        if (rv.role==='zh'  && rv.kams.indexOf(am)===-1 && tl!==email) return;
      }
      orders += num_(r.total_orders); cv += num_(r.commissionable_value); sv += num_(r.sv); n++;
    });
    return { orders:Math.round(orders), cv:Math.round(cv), sv:Math.round(sv), rows:n };
  }

  // NOV/CM actuals come from the NOV month file (only current month available).
  var curNov = (function(){
    var f = readForViewer_(email, NOV_FILE.month, clusterOverride);
    if (!f) return null;
    var novA=0,cmA=0,n=0;
    csvToObjects_(f.csv).forEach(function(r){
      var am=String(r.am_email||'').toLowerCase(), tl=String(r.tl_email||'').toLowerCase();
      if (!(rv.role==='super'||rv.role==='ceo')){
        if (rv.role==='kam' && am!==email && tl!==email) return;
        if (rv.role==='zh' && rv.kams.indexOf(am)===-1 && tl!==email) return;
      }
      novA+=num_(r.nov_actual); cmA+=num_(r.supply_cm_actual); n++;
    });
    return { novActual:Math.round(novA), cmActual:Math.round(cmA), rows:n };
  })();

  // Month-over-month trend on total_orders (the metric present in every table file).
  var points = [];
  var cm  = sumFile(TABLE_CUR_FILE);   if (cm) points.push({ label:'M', orders:cm.orders, cv:cm.cv });
  var lm  = sumFile(TABLE_LAST_FILE);  if (lm) points.push({ label:'LM', orders:lm.orders, cv:lm.cv });
  var l2  = sumFile(TABLE_2MONTH_FILE); if (l2) points.push({ label:'L2M', orders:l2.orders, cv:l2.cv });
  var l3  = sumFile(TABLE_3MONTH_FILE); if (l3) points.push({ label:'L3M', orders:l3.orders, cv:l3.cv });

  return { status:'OK', points: points, nov: curNov };
}

/**
 * Generate a per-box lead list as a Google Sheet and return its URL.
 * For most boxes the rows come from getNovBucketsV2's lead arrays; for
 * price parity we read the dedicated lead CSV (price_parity_rom_lead.csv),
 * scope it by role, and standardise it into the Brahmastra lead-list layout.
 */
function leadIdentityHeaders_() {
  return ['Priority','Res ID','Res Name','KAM','TL','City','Tier','City OV %','Portfolio OV %','Cluster','Cuisine'];
}
function leadIdentityRow_(x, priority, clusterFallback) {
  return [priority || x.priority || '', x.id || x.res_id || '', x.name || x.res_name || '',
          x.kam || x.kam_email || '', x.tl || x.zh_email || x.tl_email || '', x.city || x.city_name || '',
          x.tier || '', x.cityOv || 0, x.portfolioOv || x.orderContribution || 0, x.cluster || x.city_cluster || clusterFallback || '', x.cuisine || ''];
}
function leadMetricLayout_(boxKey, x, historyMode) {
  var weekly = historyMode === 'week';
  var omitL2m = historyMode === 'lastmonth';
  var current = weekly ? 'W' : 'M', prior = weekly ? 'LW' : 'LM', prior2 = weekly ? 'L2W' : 'L2M';
  function history_(label, value, isOrder) {
    var unit = isOrder ? '' : ' %';
    var head = [label + ' ' + current + unit, label + ' ' + prior + unit];
    var row = [value, isOrder ? (x.lastOrders||x.lmVal||0) : (x.last||0)];
    if (!omitL2m) { head.push(label + ' ' + prior2 + unit); row.push(isOrder ? (x.mo2Orders||0) : (x.mo2||0)); }
    if (weekly) { head.push(label + ' L3W' + unit); row.push(isOrder ? (x.mo3Orders||0) : (x.mo3||0)); }
    return { head:head, row:row };
  }
  if (boxKey === 'mvdsv') {
    var mh = history_('MVD/SV', x.cmVal||0);
    return { head:mh.head.concat(['Benchmark Avg %','Benchmark Max %','Target %','Increase Needed %','ZVD/SV %','PE Flag','Intended MVD/SV %','Intended MShare %','Ads/SV - ZVD/SV %','Actionable']),
             row:mh.row.concat([x.peerAvg||0,x.peerMax||0,x.target||x.lmVal||0,x.increase||0,x.zvdSv||0,x.peFlag||'',x.intendedMvd||0,x.intendedMshare||0,x.adsMinusZvd||0,x.actionable||'']) };
  }
  if (boxKey === 'salt') {
    var sh = history_('Salt/SV', x.cmVal||0);
    return { head:sh.head.concat(['Benchmark Avg %','Benchmark Max %','ZVD/SV %','PE Flag','Intended MVD/SV %','Intended MShare %','Ads/SV - ZVD/SV %','Actionable']),
             row:sh.row.concat([x.peerAvg||0,x.peerMax||0,x.zvdSv||0,x.peFlag||'',x.intendedMvd||0,x.intendedMshare||0,x.adsMinusZvd||0,x.actionable||'']) };
  }
  if (boxKey === 'zvdsv') {
    var zh = history_('ZVD/SV', x.cmVal||0);
    return { head:zh.head.concat(['MVD/SV ' + current + ' %','PE Flag','Intended MVD/SV %','Intended MShare %','Ads/SV - ZVD/SV %','ZVD ₹','Merchant Refund ₹','Customer Refund ₹','Total Burn ₹','Actionable']),
             row:zh.row.concat([x.mvdCurrent||0,x.peFlag||'',x.intendedMvd||0,x.intendedMshare||0,x.adsMinusZvd||0,x.zvd||0,x.mxRefund||0,x.cxRefund||0,x.totalBurn||0,x.actionable||'']) };
  }
  if (boxKey === 'visibility') {
    var vh = history_('Visibility', x.cmVal||0);
    vh.head.splice(1,0,'Target Visibility %'); vh.row.splice(1,0,x.lmVal||95);
    return vh;
  }
  if (boxKey === 'notActive') return history_('Orders', x.cmVal||0, true);
  if (boxKey === 'commValue') return { head:['Commission Revenue / CV %','Portfolio Benchmark Avg %','Gap %'], row:[x.cmVal||0,x.lmVal||0,x.gap||0] };
  if (boxKey === 'pc') return { head:['Packaging / ASV %','Target Packaging / ASV %'], row:[x.cmVal||0,x.lmVal||0] };
  if (boxKey === 'refund') return { head:['Merchant Refund ₹','Customer Refund ₹','Total Refund ₹','Refund / Order ₹'], row:[x.mxRefund||0,x.cxRefund||0,x.totalBurn||x.cmVal||0,x.orders>0 ? +((x.totalBurn||x.cmVal||0)/x.orders).toFixed(2) : 0] };
  return { head:['M Value','Benchmark / Target Value'], row:[x.cmVal||0,x.lmVal||0] };
}
function normalizedLeadKey_(s) { return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
// Keep business source columns intact for lookup, but standardise what users
// see in lead-list headers: M = current month, LM/L2M = prior months.
function displayLeadHeader_(header) {
  return String(header||'')
    .replace(/\bMo2M\b/gi, 'L2M')
    .replace(/\bMoM\b/gi, 'LM')
    .replace(/\bCurrent Month\b/gi, 'M')
    .replace(/\bCurrent\b/gi, 'M');
}
function rawLeadValue_(row, names) {
  var keys = {}; Object.keys(row||{}).forEach(function(k){ keys[normalizedLeadKey_(k)] = row[k]; });
  for (var i=0;i<names.length;i++) { var v = keys[normalizedLeadKey_(names[i])]; if (v !== undefined && v !== null && v !== '') return v; }
  return '';
}
function externalLeadLayout_(rows, sourceHeaders, rv, amtl) {
  // Dedicated planning/parity CSVs can omit restaurant master fields.  Keep
  // their own value when present, otherwise complete it from AMTL by Res ID.
  amtl = amtl || {};
  var used = ['priority','priorityflag','resid','restaurantid','resname','restaurantname','kam','kamemail','am','amemail','tl','tlemail','zh','zhemail','city','cityname','tier','cityov','cityovcontribution','portfolioov','resovcontribution','totalresov','ov','cluster','citycluster','cuisine'];
  var extras = (sourceHeaders||[]).filter(function(h){ return used.indexOf(normalizedLeadKey_(h)) === -1; });
  var out = (rows||[]).map(function(r){
    var rid = rawLeadValue_(r,['res_id','res id','restaurant_id']);
    var master = amtl[normId_(rid)] || amtl[String(rid||'').trim()] || {};
    return { raw:r, id:rid,
      name:rawLeadValue_(r,['res_name','res name','restaurant_name','restaurant']) || master.res_name || '',
      kam:rawLeadValue_(r,['kam_email','kam email','am_email']) || master.am_email || '',
      tl:rawLeadValue_(r,['zh_email','zh email','tl_email','tl']) || master.tl_email || '',
      city:rawLeadValue_(r,['city','city_name']) || master.city || '', tier:rawLeadValue_(r,['tier']) || master.tier || '', cityOv:rawLeadValue_(r,['city_ov','city ov','city_ov_contribution']),
      portfolioOv:rawLeadValue_(r,['portfolio_ov','res_ov_contribution','total_res_ov']), cluster:rawLeadValue_(r,['city_cluster','cluster']) || master.cluster || '',
      cuisine:rawLeadValue_(r,['cuisine']) || master.cuisine || '', priority:rawLeadValue_(r,['priority','priority flag','priority_flag']),
      score:num_(rawLeadValue_(r,['res_ov_contribution','total_res_ov','ov','total_orders'])) };
  }).sort(function(a,b){ return b.score-a.score; });
  var cityScore = {}, kamScore = {};
  out.forEach(function(x){
    cityScore[x.city||'Unknown'] = (cityScore[x.city||'Unknown'] || 0) + Math.max(0,x.score||0);
    kamScore[x.kam||'Unknown'] = (kamScore[x.kam||'Unknown'] || 0) + Math.max(0,x.score||0);
  });
  out.forEach(function(x){
    // Dedicated CSVs do not always carry these two shares, so derive them
    // from the scoped rows: restaurant / city and restaurant / KAM portfolio.
    x.cityOv = cityScore[x.city||'Unknown']>0 ? +(Math.max(0,x.score||0)/cityScore[x.city||'Unknown']*100).toFixed(2) : 0;
    x.portfolioOv = kamScore[x.kam||'Unknown']>0 ? +(Math.max(0,x.score||0)/kamScore[x.kam||'Unknown']*100).toFixed(2) : 0;
  });
  out.sort(function(a,b){ return (b.cityOv||0)-(a.cityOv||0) || (b.portfolioOv||0)-(a.portfolioOv||0); });
  var n = out.length;
  out.forEach(function(x,i){ if (!/^P[012]$/i.test(String(x.priority||''))) x.priority = i<n*.2?'P0':(i<n*.5?'P1':'P2'); else x.priority=String(x.priority).toUpperCase(); });
  return { head:leadIdentityHeaders_().concat(extras.map(displayLeadHeader_)), data:out.map(function(x){ return leadIdentityRow_(x,x.priority,rv.cluster).concat(extras.map(function(h){ return x.raw[h] == null ? '' : x.raw[h]; })); }) };
}
function generateBoxLeadList(period, boxKey, viewer, clusterOverride, kamFilter) {
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride);
  if (isSuperCoreFolder_(rv, clusterOverride)) {
    return { status:'SUPER_CORE_ONLY', message:'Detailed lead lists are available from the relevant cluster or KAM dashboard.' };
  }
  var leadAmtl = loadAmtl_(email, clusterOverride);

  var head, data, title, driveRows = [];
  var kf = String(kamFilter||'').trim().toLowerCase();   // optional: limit to one KAM
  // A card-level export initiated by a KAM is always personal. Do not trust
  // only the bucket display filter here: source CSVs can contain rows whose
  // TL field matches while their owning KAM is someone else. Force the actual
  // KAM email into the export scope for every card (Not Active, MVD/SV, etc.).
  if (rv.role === 'kam') kf = String(rv.email || email).trim().toLowerCase();
  var scopeKams = null;
  if (kf.indexOf('zh:') === 0) {
    var zh = kf.substring(3);
    scopeKams = uniq_(loadMaster_().filter(function(r){
      return (r.city_cluster === rv.cluster) && String(r.zh_email||'').toLowerCase() === zh;
    }).map(function(r){ return String(r.kam_email||'').toLowerCase(); }));
  }
  function selectedKam_(k) { return scopeKams ? scopeKams.indexOf(k)!==-1 : (!kf || k===kf); }
  // A Last Month tracker is a different working sheet from the current-M
  // tracker. Keep the 5-day reuse guard period-specific so it never returns
  // the wrong period's URL.
  // v2 forces a one-time fresh workbook after the shared identity layout
  // gained the AMTL Tier column; older sheets cannot be backfilled safely.
  var weeklyScope = activeWeekPeriod_(email, clusterOverride, String(period || '').toLowerCase());
  var metricScope = (kf || 'all') + '::' + String(period || 'month').toLowerCase() + (weeklyScope ? ('::' + weeklyScope) : '') + '::tier_v2';
  var priorMetricList = metricLeadCooldownCheck_(email, rv.cluster, boxKey, metricScope);
  // A Settings removal used to delete only the Ongoing Drive card while the
  // five-day cache kept returning its old Sheet URL. Treat that orphan cache
  // as deleted so the next click creates and registers a complete new list.
  if (priorMetricList.blocked && !hasRegisteredLeadDriveUrl_(priorMetricList.url)) {
    metricLeadCooldownRemoveByUrl_(priorMetricList.url);
    priorMetricList = { blocked:false };
  }
  if (priorMetricList.blocked) {
    return { status:'COOLDOWN', url:priorMetricList.url, count:priorMetricList.count,
             label:priorMetricList.label, message:priorMetricList.message };
  }

  if (boxKey === 'priceParity') {
    var pf = readForViewer_(email, PARITY_LEAD_FILE, clusterOverride);
    var prows = (pf ? csvToObjects_(pf.csv) : []).filter(function(r){
      var k = String(r.kam_email||'').trim().toLowerCase();
      if (!selectedKam_(k)) return false;
      if (rv.role === 'super' || rv.role === 'ceo') return true;
      if (rv.role === 'zh')  return rv.kams.indexOf(k) !== -1;
      if (rv.role === 'kam') return k === email;
      return false;
    });
    var parityLayout = externalLeadLayout_(prows, pf ? csvSourceHeaders_(pf.csv) : [], rv, leadAmtl);
    head = parityLayout.head; data = parityLayout.data;
    title = 'Price Disparity Leads';
    driveRows = prows;
  } else if (boxKey === 'adscv') {
    // Ads/CV has a dedicated planning file. The card metric can still use the
    // core table, while the lead-list keeps every supplied planning column.
    var af = readForViewer_(email, ADS_PLAN_FILE, clusterOverride);
    if (af) {
      var arows = csvToObjects_(af.csv).filter(function(r){
        var k = String(r.kam_email||r.am_email||'').trim().toLowerCase();
        if (!selectedKam_(k)) return false;
        if (rv.role === 'super' || rv.role === 'ceo') return true;
        if (rv.role === 'zh') return rv.kams.indexOf(k) !== -1;
        return k === email;
      });
      head = csvSourceHeaders_(af.csv);
      if (!head.length) head = ['Res id','res name','City','City_Cluster','KAM_email','ZH_email','OV','CV MTD','Projected Month CV','SV+PC','LM-2 Ads/CV','LM-1 Ads/CV','LM Ads/CV','LM Billed Amount','Target Ads/cv','Projected cv','Target Billed','Target BR','Incremental BR Required','Current Ads/CV','Current Month Billed Amount','Eff BR + AR','Effective Ads Delivery','GM Model','GM X%','Projected Billed Amount','Delta','Action','Action 2'];
      var adsLayout = externalLeadLayout_(arows, head, rv, leadAmtl); head = adsLayout.head; data = adsLayout.data;
      title = 'Ads/CV Leads';
      driveRows = arows;
    } else {
      // Still create a card-level workbook so the button consistently becomes
      // Open Lead List.  It will fill automatically once ads_planing arrives.
      head = ['Res id','res name','City','City_Cluster','KAM_email','ZH_email','OV','CV MTD','Projected Month CV','SV+PC','LM-2 Ads/CV','LM-1 Ads/CV','LM Ads/CV','LM Billed Amount','Target Ads/cv','Projected cv','Target Billed','Target BR','Incremental BR Required','Current Ads/CV','Current Month Billed Amount','Eff BR + AR','Effective Ads Delivery','GM Model','GM X%','Projected Billed Amount','Delta','Action','Action 2'];
      var emptyAdsLayout = externalLeadLayout_([], head, rv, leadAmtl); head = emptyAdsLayout.head; data = emptyAdsLayout.data;
      title = 'Ads/CV Leads';
      driveRows = [];
    }
  } else {
    var res = getNovBucketsV2(period, email, clusterOverride);
    if (res.status !== 'OK') return { status:'NO_DATA' };
    var all = (res.nov||[]).concat(res.val||[]);
    var box = all.filter(function(b){ return b.key === boxKey; })[0];
    if (!box) return { status:'NO_DATA', message:'Unknown lead-list card: ' + boxKey };
    var leadRows = (box.leads||[]).slice();
    if (kf) leadRows = leadRows.filter(function(x){ return selectedKam_(String(x.kam||'').trim().toLowerCase()); });
    // Prioritise by the city's contribution to the selected portfolio. P0 is
    // the top 20%, P1 the next 30%, P2 the remainder.
    leadRows = leadRows.slice().sort(function(a,b){ return (b.cityOv||0) - (a.cityOv||0) || (b.portfolioOv||0) - (a.portfolioOv||0); });
    var n = leadRows.length;
    leadRows.forEach(function(x, i){ x.priority = i < n*.2 ? 'P0' : (i < n*.5 ? 'P1' : 'P2'); });
    var leadHistoryMode = (period === 'lastmonth') ? 'lastmonth' : ((period === 'week' || period === 'lastweek') ? 'week' : 'month');
    var firstLayout = leadMetricLayout_(boxKey, leadRows[0] || {}, leadHistoryMode);
    head = leadIdentityHeaders_().concat(firstLayout.head);
    data = leadRows.map(function(x){
      return leadIdentityRow_(x,x.priority,rv.cluster).concat(leadMetricLayout_(boxKey,x,leadHistoryMode).row);
    });
    title = box.label + ' Leads';
    driveRows = leadRows;
  }

  // Every new lead list has the same three working columns at the end.
  head = head.concat(['Approached','Comments','Converted']);
  data = data.map(function(r){ return r.concat(['','','']); });

  var clusterName = (rv.cluster || 'cluster').replace(/[\\/:*?"<>|]/g,'').trim() || 'cluster';
  var name = 'Brahmastra_' + boxKey + '_' + clusterName.replace(/\s+/g,'') +
             (kf ? '_' + kf.split('@')[0] : '') + '_' + period + '_' +
             Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');

  var ss = SpreadsheetApp.create(name);
  var summarySh = ss.getSheets()[0];
  summarySh.setName('Summary');
  var leadTabName = title.substring(0,90);
  var sh = ss.insertSheet(leadTabName);
  writeLeadSheet_(sh,head,data,[head.length-2,head.length]);

  // Every card-created workbook gets the same useful one-page summary as the
  // overall list, adjusted to its tracking columns.
  var colLetter = function(n){ var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; };
  var trackingCol = head.length-2;
  var convertedCol = head.length;
  var ref = "'" + leadTabName.replace(/'/g, "''") + "'!";
  var summaryRows = [
    [title.toUpperCase() + ' — SUMMARY',''],
    ['Cluster',rv.cluster||''],
    ['Period',period],
    ['Total restaurants',data.length],
    ['', ''],
    ['Approached — Yes', '=COUNTIF(' + ref + colLetter(trackingCol) + '2:' + colLetter(trackingCol) + ',"Yes")'],
    ['Approached — No', '=COUNTIF(' + ref + colLetter(trackingCol) + '2:' + colLetter(trackingCol) + ',"No")']
  ];
  if (convertedCol) {
    summaryRows.push(['Converted — Yes','=COUNTIF(' + ref + colLetter(convertedCol) + '2:' + colLetter(convertedCol) + ',"Yes")']);
    summaryRows.push(['Converted — No','=COUNTIF(' + ref + colLetter(convertedCol) + '2:' + colLetter(convertedCol) + ',"No")']);
  }
  summarySh.getRange(1,1,summaryRows.length,2).setValues(summaryRows);
  summarySh.getRange(1,1,1,2).merge().setFontWeight('bold').setFontColor('#fff').setBackground('#141414');
  summarySh.getRange(2,1,summaryRows.length-1,1).setFontWeight('bold');
  summarySh.setFrozenRows(1); summarySh.setColumnWidth(1,270); summarySh.setColumnWidth(2,160);

  var fileId = ss.getId();
  var savedTo = '';
  try {
    var f = DriveApp.getFileById(fileId);
    var sub = getClusterSubfolder_(LEADLIST_FOLDER_ID, clusterName);   // per-cluster folder
    sub.addFile(f); try { DriveApp.getRootFolder().removeFile(f); } catch(e2){}
    f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
    savedTo = clusterName;
  } catch(e){}

  // append to the central log sheet
  try { logBoxLeadList_(email, rv, boxKey, kf, period, data.length, ss.getUrl(), clusterName); } catch(e){}
  // A card lead list is also an Ongoing Drive. Its recipients are determined
  // from the creator's hierarchy, never from a broad all-user broadcast.
  try { registerSelfMadeLeadDrive_({ rv:rv, creator:email, name:title, url:ss.getUrl(), leadTab:leadTabName, rows:driveRows }); } catch(e) {}

  try { metricLeadCooldownRecord_(email, rv.cluster, boxKey, metricScope, ss.getUrl(), data.length, title); } catch(e) {}

  return { status:'OK', url: ss.getUrl(), count: data.length, label: title, cluster: savedTo };
}

// Explicit endpoints per card keep each dashboard CTA independent.  They use
// the shared sheet writer above, but a failure in one card can never require a
// client-side generic method name or block another card's Open Lead List flow.
function generateNotActiveLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'notActive', viewer, clusterOverride, kamFilter); }
function generateVisibilityLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'visibility', viewer, clusterOverride, kamFilter); }
function generateMvdSvLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'mvdsv', viewer, clusterOverride, kamFilter); }
function generateSaltLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'salt', viewer, clusterOverride, kamFilter); }
function generatePriceParityLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'priceParity', viewer, clusterOverride, kamFilter); }
function generatePackagingLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'pc', viewer, clusterOverride, kamFilter); }
function generateAdsCvLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'adscv', viewer, clusterOverride, kamFilter); }
function generateCommissionRevenueLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'commValue', viewer, clusterOverride, kamFilter); }
function generateZvdSvLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'zvdsv', viewer, clusterOverride, kamFilter); }
function generateRefundLeadList(period, viewer, clusterOverride, kamFilter) { return generateBoxLeadList(period, 'refund', viewer, clusterOverride, kamFilter); }

// Settings > Connectors: show the exact base names the app searches in the
// active cluster folder, including whether the newest matching CSV was found.
function getDataConnectors(viewer, clusterOverride) {
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var items = [
    { label:'M table', base:TABLE_CUR_FILE }, { label:'Weekly table (M / LW / L2W / L3W)', base:TABLE_WEEK_FILE }, { label:'LM table', base:TABLE_LAST_FILE },
    { label:'L2M table', base:TABLE_2MONTH_FILE }, { label:'AMTL mapping', base:AMTL_FILE },
    { label:'Price Disparity lead list', base:PARITY_LEAD_FILE }, { label:'Chalo 49 eligible restaurants', base:CHALO_FILE },
    { label:'Ads/CV planning lead list', base:ADS_PLAN_FILE }
  ];
  return { status:'OK', items:items.map(function(x){
    var f = null; try { f = readForViewer_(email, x.base, clusterOverride); } catch(e) {}
    return { label:x.label, base:x.base, found:!!f, fileName:f ? f.name : '' };
  }) };
}

/**
 * Create one workbook for either NOV or CM, with a Summary tab and one tab for
 * every actionable metric. This is deliberately separate from the individual
 * card export so the card path stays fast.
 */
function generateOverallBoxLeadList(period, group, viewer, clusterOverride, kamFilter) {
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride);
  if (isSuperCoreFolder_(rv, clusterOverride)) {
    return { status:'SUPER_CORE_ONLY', message:'Detailed lead lists are available from the relevant cluster or KAM dashboard.' };
  }
  var leadAmtl = loadAmtl_(email, clusterOverride);
  var result = getNovBucketsV2(period, email, clusterOverride);
  if (result.status !== 'OK') return { status:'NO_DATA' };
  var buckets = group === 'cm' ? (result.val||[]) : (result.nov||[]);
  var kf = String(kamFilter||'').trim().toLowerCase(), scopeKams = null;
  if (kf.indexOf('zh:')===0) {
    var zh = kf.substring(3);
    scopeKams = uniq_(loadMaster_().filter(function(r){ return r.city_cluster===rv.cluster && String(r.zh_email||'').toLowerCase()===zh; })
      .map(function(r){ return String(r.kam_email||'').toLowerCase(); }));
  }
  function selectedKam_(k) { return scopeKams ? scopeKams.indexOf(String(k||'').toLowerCase())!==-1 : (!kf || String(k||'').toLowerCase()===kf); }
  var overallMetric = 'overall_' + (group === 'cm' ? 'cm' : 'nov');
  var overallWeekScope = activeWeekPeriod_(email, clusterOverride, String(period || '').toLowerCase());
  var overallScope = (kf || 'all') + '::' + String(period || 'month').toLowerCase() + (overallWeekScope ? ('::' + overallWeekScope) : '') + '::tier_v2';
  var priorOverall = metricLeadCooldownCheck_(email, rv.cluster, overallMetric, overallScope);
  if (priorOverall.blocked && !hasRegisteredLeadDriveUrl_(priorOverall.url)) {
    metricLeadCooldownRemoveByUrl_(priorOverall.url);
    priorOverall = { blocked:false };
  }
  if (priorOverall.blocked) {
    return { status:'COOLDOWN', url:priorOverall.url, count:priorOverall.count,
             label:priorOverall.label, message:priorOverall.message };
  }
  // Build one tab for every active card in this section, including cards that
  // currently have zero rows.  This keeps Overall Lead List consistent with
  // card-level sheets and still gives the user an Open Sheet link.
  buckets = buckets.filter(function(b){ return b.hasData && b.key !== 'chalo49' && b.key !== 'acquisition'; });
  if (!buckets.length) return { status:'EMPTY', message:'No actionable cards found for this selection.' };

  var cluster = (rv.cluster||'cluster').replace(/[\\/:*?"<>|]/g,'') || 'cluster';
  var ss = SpreadsheetApp.create('Brahmastra_' + (group==='cm'?'CM':'NOV') + '_Overall_' + cluster + '_' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm'));
  var summary = ss.getActiveSheet(); summary.setName('Summary');
  var summaryRows = [['OVERALL ' + (group==='cm'?'CM':'NOV') + ' LEAD LIST','','',''],
                     ['Cluster',rv.cluster||'','',''],['Role',rv.role||'','',''],
                     ['Metric','Restaurants','Approached — Yes','Converted — Yes']];
  var overallDriveRows = [];
  function colLetter_(n) { var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; }
  buckets.forEach(function(b){
    var rows = b.leads.slice();
    if (kf) rows = rows.filter(function(x){ return selectedKam_(x.kam); });
    var head, data;
    if (b.key === 'priceParity') {
      // Overall workbooks must retain every Price Parity CSV column as well.
      var pf = readForViewer_(email, PARITY_LEAD_FILE, clusterOverride);
      var raw = pf ? csvToObjects_(pf.csv).filter(function(r){
        var k = String(r.kam_email||'').trim().toLowerCase();
        if (!selectedKam_(k)) return false;
        if (rv.role === 'super' || rv.role === 'ceo') return true;
        if (rv.role === 'zh') return rv.kams.indexOf(k)!==-1 || String(r.zh_email||'').trim().toLowerCase()===rv.email;
        return rv.role === 'kam' && k===email;
      }) : [];
      var overallParityLayout = externalLeadLayout_(raw, pf ? csvSourceHeaders_(pf.csv) : [], rv, leadAmtl);
      head = overallParityLayout.head; data = overallParityLayout.data;
      overallDriveRows = overallDriveRows.concat(raw);
    } else if (b.key === 'adscv') {
      // Overall CM must use the Ads Planning source too—not the generic card
      // rows—so the downloaded Ads/CV tab has the exact planning fields.
      var af = readForViewer_(email, ADS_PLAN_FILE, clusterOverride);
      var ah = af ? csvSourceHeaders_(af.csv) : [];
      if (!ah.length) ah = ['Res id','res name','City','City_Cluster','KAM_email','ZH_email','OV','CV MTD','Projected Month CV','SV+PC','LM-2 Ads/CV','LM-1 Ads/CV','LM Ads/CV','LM Billed Amount','Target Ads/cv','Projected cv','Target Billed','Target BR','Incremental BR Required','Current Ads/CV','Current Month Billed Amount','Eff BR + AR','Effective Ads Delivery','GM Model','GM X%','Projected Billed Amount','Delta','Action','Action 2'];
      var ar = af ? csvToObjects_(af.csv).filter(function(r){
        var k = String(r.kam_email||r.am_email||'').trim().toLowerCase();
        if (!selectedKam_(k)) return false;
        if (rv.role === 'super' || rv.role === 'ceo') return true;
        if (rv.role === 'zh') return rv.kams.indexOf(k)!==-1;
        return k === email;
      }) : [];
      var overallAdsLayout = externalLeadLayout_(ar, ah, rv, leadAmtl);
      head = overallAdsLayout.head; data = overallAdsLayout.data;
      overallDriveRows = overallDriveRows.concat(ar);
    } else {
      rows.sort(function(a,b2){ return (b2.cityOv||0)-(a.cityOv||0) || (b2.portfolioOv||0)-(a.portfolioOv||0); });
      var n = rows.length;
      var overallHistoryMode = (period === 'lastmonth') ? 'lastmonth' : ((period === 'week' || period === 'lastweek') ? 'week' : 'month');
      var overallFirstLayout = leadMetricLayout_(b.key, rows[0] || {}, overallHistoryMode);
      head = leadIdentityHeaders_().concat(overallFirstLayout.head);
      data = rows.map(function(x,i){
        var p = i<n*.2?'P0':(i<n*.5?'P1':'P2');
        return leadIdentityRow_(x,p,rv.cluster).concat(leadMetricLayout_(b.key,x,overallHistoryMode).row);
      });
      overallDriveRows = overallDriveRows.concat(rows);
    }
    head = head.concat(['Approached','Comments','Converted']);
    data = data.map(function(r){ return r.concat(['','','']); });
    var sh = ss.insertSheet(String(b.label).substring(0,90));
    writeLeadSheet_(sh,head,data,[head.length-2,head.length]);
    var actionCol = head.length-2;
    var convertedCol = head.length;
    var sheetRef = "'" + sh.getName().replace(/'/g, "''") + "'!";
    summaryRows.push([
      b.label, data.length,
      '=COUNTIF(' + sheetRef + colLetter_(actionCol) + '2:' + colLetter_(actionCol) + ',"Yes")',
      convertedCol ? '=COUNTIF(' + sheetRef + colLetter_(convertedCol) + '2:' + colLetter_(convertedCol) + ',"Yes")' : '—'
    ]);
  });
  summary.getRange(1,1,summaryRows.length,4).setValues(summaryRows);
  summary.getRange(1,1,1,4).merge().setFontWeight('bold').setFontColor('#fff').setBackground('#141414');
  summary.getRange(4,1,1,4).setFontWeight('bold').setBackground('#FEF3C7');
  summary.setFrozenRows(4); summary.autoResizeColumns(1,4);
  try {
    var f = DriveApp.getFileById(ss.getId());
    getClusterSubfolder_(LEADLIST_FOLDER_ID, cluster).addFile(f);
    try { DriveApp.getRootFolder().removeFile(f); } catch(e) {}
    f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
  } catch(e) {}
  try {
    registerSelfMadeLeadDrive_({ rv:rv, creator:email,
      name:(group==='cm'?'CM':'NOV') + ' Overall Lead List', url:ss.getUrl(), leadTab:'Summary', rows:overallDriveRows });
  } catch(e) {}
  var overallLabel = (group==='cm'?'CM':'NOV') + ' Overall Lead List';
  // Overall lists follow the same auditable lifecycle as card lists. This log
  // row is also removed when its Settings/Ongoing Drive entry is removed.
  try { logBoxLeadList_(email, rv, overallMetric, kf, period, overallDriveRows.length, ss.getUrl(), cluster); } catch(e) {}
  try { metricLeadCooldownRecord_(email, rv.cluster, overallMetric, overallScope, ss.getUrl(), summaryRows.length-4, overallLabel); } catch(e) {}
  return { status:'OK', url:ss.getUrl(), count:summaryRows.length-4, label:overallLabel };
}

// Get (or create) a subfolder by name inside a parent folder.
function getClusterSubfolder_(parentId, name) {
  var parent = DriveApp.getFolderById(parentId);
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

// Append a row to the central lead-list log sheet (created once, reused).
function logBoxLeadList_(email, rv, boxKey, kamFilter, period, count, url, cluster) {
  var LOG_NAME = 'Brahmastra_LeadList_Log';
  var folder = DriveApp.getFolderById(LEADLIST_LOG_FOLDER_ID);
  var ss;
  var it = folder.getFilesByName(LOG_NAME);
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(LOG_NAME);
    var f = DriveApp.getFileById(ss.getId());
    folder.addFile(f); try { DriveApp.getRootFolder().removeFile(f); } catch(e){}
    var sh0 = ss.getSheets()[0];
    sh0.getRange(1,1,1,9).setValues([['Timestamp','User','Role','Cluster','Box','KAM Filter','Period','Rows','Sheet URL']])
       .setFontWeight('bold').setBackground('#141414').setFontColor('#F5D77E');
    sh0.setFrozenRows(1);
  }
  var sh = ss.getSheets()[0];
  sh.appendRow([ new Date(), email, rv.role, cluster, boxKey, kamFilter||'(all)', period, count, url ]);
}

// Remove the audit row(s) for one generated lead-list URL. The Sheet itself
// is intentionally preserved; deleting a Settings record means "forget this
// generated run and allow a fresh one", not destructively delete user data.
function removeLeadListLogByUrl_(url) {
  url = String(url || '').trim();
  if (!url) return;
  try {
    var folder = DriveApp.getFolderById(LEADLIST_LOG_FOLDER_ID);
    var it = folder.getFilesByName('Brahmastra_LeadList_Log');
    if (!it.hasNext()) return;
    var sh = SpreadsheetApp.open(it.next()).getSheets()[0];
    var last = sh.getLastRow(); if (last < 2) return;
    var vals = sh.getRange(2,9,last-1,1).getDisplayValues();
    for (var i=vals.length-1;i>=0;i--) if (String(vals[i][0]||'').trim() === url) sh.deleteRow(i+2);
  } catch (e) {}
}

// Fallback for the card UI: if a long Sheet-creation execution disconnects
// before its response reaches the browser, retrieve the newest list directly
// from the same cluster folder and still give the user an Open Lead List link.
function getLatestBoxLeadList(boxKey, viewer, clusterOverride, period) {
  try {
    var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
    var rv = resolveViewer_(email, clusterOverride);
    var cluster = (rv.cluster||'cluster').replace(/[\\/:*?"<>|]/g,'').trim() || 'cluster';
    var folder = getClusterSubfolder_(LEADLIST_FOLDER_ID, cluster);
    var prefix = 'Brahmastra_' + String(boxKey||'') + '_' + cluster.replace(/\s+/g,'');
    var periodNeedle = '_' + String(period || '').toLowerCase() + '_';
    var it = folder.getFiles(), best = null;
    while (it.hasNext()) {
      var f = it.next();
      if (f.getName().indexOf(prefix) !== 0) continue;
      if (period && f.getName().toLowerCase().indexOf(periodNeedle) === -1) continue;
      if (!best || f.getLastUpdated().getTime() > best.getLastUpdated().getTime()) best = f;
    }
    return best ? { status:'OK', url:'https://docs.google.com/spreadsheets/d/' + best.getId() + '/edit', name:best.getName() }
                : { status:'EMPTY' };
  } catch(e) { return { status:'ERR', message:String(e&&e.message||e) }; }
}



// Lightweight: used by the loading screen to greet the user immediately,
// before the (slower) data load finishes.
// ---- Access control -------------------------------------------------------
// A person can use the dashboard if they are an admin, a tracked TL/ZH, they
// own restaurants in the data, or an admin has granted them access manually.
const ACCESS_PROP = 'GRANTED_USERS';
const ACCESS_REQUEST_TO = 'sachin.bajaj@zomato.com';
const ACCESS_REQUEST_CC = 'arvind.palaniappan@zomato.com';

function getGrantedUsers_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(ACCESS_PROP);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) { return []; }
}

function isGranted_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return false;
  return getGrantedUsers_().indexOf(email) !== -1;
}

// Does this person own any restaurants in the current data?
// This runs on every page load, so it does a cheap substring scan of the raw
// CSV instead of parsing thousands of rows.
function hasPortfolio_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return false;
  try {
    var cache = CacheService.getScriptCache();
    var key = 'hasPf_' + email;
    var hit = cache.get(key);
    if (hit !== null) return hit === '1';

    var f = readPeriodFile('month') || readPeriodFile('week') || readPeriodFile('day') || readPeriodFile('quarter');
    var found = false;
    if (f && f.csv) found = String(f.csv).toLowerCase().indexOf(email) !== -1;
    cache.put(key, found ? '1' : '0', 1800);   // 30 min is plenty
    return found;
  } catch (e) { return false; }
}

/**
 * Called by the loading screen. Returns the greeting details plus whether the
 * person is allowed in, so the UI can show an access-request screen instead.
 */
function getWhoAmI(viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  var email = String(ctx.email || '').toLowerCase();
  var allowed = ctx.isAdmin || isMappedInMaster_(email) || isGranted_(email) || hasPortfolio_(email);
  var rv = {};
  try { rv = resolveViewer_(String(ctx.actualEmail || viewer || email).toLowerCase(), clusterOverride || ''); } catch (e) { rv = {}; }
  var myClusters = [];
  try { if (!ctx.isViewingAs && rv.role === 'ceo') myClusters = ceoClusters_(String(ctx.actualEmail || email)); } catch(e){}
  var actual=weeklyPlanLower_(ctx.actualEmail||viewer||email),designation='';
  try{designation=PropertiesService.getUserProperties().getProperty('BEAT_DESIGNATION_'+actual)||'';}catch(ignoreDesignation){}
  return {
    email: ctx.email,
    isAdmin: ctx.isAdmin,
    allowed: !!allowed,
    requestTo: ACCESS_REQUEST_TO,
    requestCc: ACCESS_REQUEST_CC,
    cluster: rv.cluster || '',
    clusterKey: rv.clusterKey || '',
    folderId: rv.folderId || '',
    role: rv.role || '', isSuper:!!isSuperUser_(ctx.actualEmail || ctx.email),
    myClusters: myClusters,      // for multi-cluster CEOs (switcher)
    actualEmail:ctx.actualEmail || '', actualIsAdmin:!!ctx.actualIsAdmin,
    isViewingAs:!!ctx.isViewingAs, viewAsKam:ctx.viewAsKam || '',
    isPlus:!!rv.isPlus, designation:designation, needsDesignation:!!rv.isPlus&&!designation,
    officeLatitude:rv.officeLatitude,officeLongitude:rv.officeLongitude
  };
}

function saveBeatDesignation(designation,viewer){
  var email=weeklyPlanLower_(viewer||getCurrentEmail_()),rv=resolveViewer_(email,''),value=String(designation||'').trim();
  if(!rv.isPlus)throw new Error('Designation setup is only required for Plus access users.');
  if(value.length<2||value.length>80)throw new Error('Enter a valid designation.');
  PropertiesService.getUserProperties().setProperty('BEAT_DESIGNATION_'+email,value);
  return {ok:true,designation:value};
}

/** Send the access request on the user's behalf. */
function requestAccess(note, viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  var who = ctx.email || 'unknown user';
  var cluster = (typeof CLUSTER_LABEL !== 'undefined' && CLUSTER_LABEL) ? CLUSTER_LABEL : 'ROM';
  var subject = 'Brahmastra access request \u2014 ' + who + ' (' + cluster + ')';
  var body =
    who + ' is asking for access to Brahmastra (' + cluster + ').\n\n' +
    (note ? ('Their note:\n' + note + '\n\n') : '') +
    'To grant access, open the dashboard as an admin, go to Settings and add ' + who + '.\n';
  try {
    MailApp.sendEmail({
      to: ACCESS_REQUEST_TO,
      cc: ACCESS_REQUEST_CC,
      subject: subject,
      body: body
    });
    return { status:'OK' };
  } catch (e) {
    return { status:'ERR', message: (e && e.message) ? e.message : String(e) };
  }
}

function accessCluster_(clusterOverride) {
  var wanted = String(clusterOverride || '').trim();
  if (!wanted || wanted === 'super_core_admin' || wanted.toLowerCase() === 'all') return '';
  var row = loadMaster_().filter(function(r){
    return r.city_cluster === wanted || clusterKey_(r.city_cluster) === clusterKey_(wanted);
  })[0];
  return row ? row.city_cluster : '';
}

/** Admin-only: list manually granted admins for the current dashboard scope. */
function getAccessList(viewer, clusterOverride) {
  setViewer_(viewer);
  setClusterOverride_(clusterOverride || '');
  var ctx = getUserContext();
  if (!ctx.isAdmin) return { status:'FORBIDDEN', users: [] };
  var dynamic = getDynamicSuperUsers_();
  var cluster = isSuperUser_(ctx.actualEmail || ctx.email) ? accessCluster_(clusterOverride) : '';
  return {
    status:'OK', users:cluster ? clusterAdminUsers_(cluster) : getGrantedUsers_(), admins:getSuperUsers_(),
    superAdmins:getSuperUsers_().map(function(email){ return { email:email, locked:SUPER_USERS.indexOf(email)!==-1 }; }),
    canManageSuper:isSuperUser_(ctx.email), cluster:cluster
  };
}

/** Admin-only: grant access to an email. */
function grantAccess(email, viewer, clusterOverride) {
  setViewer_(viewer);
  setClusterOverride_(clusterOverride || '');
  var ctx = getUserContext();
  if (!ctx.isAdmin) return { status:'FORBIDDEN' };
  email = String(email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return { status:'BAD_EMAIL' };
  var cluster = isSuperUser_(ctx.actualEmail || ctx.email) ? accessCluster_(clusterOverride) : '';
  if (cluster) {
    var clusterMap = clusterAdminMap_();
    var clusters = clusterMap[email] || [];
    if (!clusters.some(function(c){ return clusterKey_(c) === clusterKey_(cluster); })) clusters.push(cluster);
    clusterMap[email] = clusters;
    clusterAdminMapSave_(clusterMap);
    return { status:'OK', users:clusterAdminUsers_(cluster), cluster:cluster };
  }
  var list = getGrantedUsers_();
  if (list.indexOf(email) === -1) list.push(email);
  PropertiesService.getScriptProperties().setProperty(ACCESS_PROP, JSON.stringify(list));
  return { status:'OK', users: list };
}

/** Admin-only: remove someone's manual access. */
function revokeAccess(email, viewer, clusterOverride) {
  setViewer_(viewer);
  setClusterOverride_(clusterOverride || '');
  var ctx = getUserContext();
  if (!ctx.isAdmin) return { status:'FORBIDDEN' };
  email = String(email || '').toLowerCase().trim();
  var cluster = isSuperUser_(ctx.actualEmail || ctx.email) ? accessCluster_(clusterOverride) : '';
  if (cluster) {
    var clusterMap = clusterAdminMap_();
    var clusters = (clusterMap[email] || []).filter(function(c){ return clusterKey_(c) !== clusterKey_(cluster); });
    if (clusters.length) clusterMap[email] = clusters; else delete clusterMap[email];
    clusterAdminMapSave_(clusterMap);
    return { status:'OK', users:clusterAdminUsers_(cluster), cluster:cluster };
  }
  var list = getGrantedUsers_().filter(function(e){ return e !== email; });
  PropertiesService.getScriptProperties().setProperty(ACCESS_PROP, JSON.stringify(list));
  return { status:'OK', users: list };
}

/** Super-core-only: grant Super Core Admin access from Settings. */
function grantSuperAdmin(email, viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!isSuperUser_(ctx.email)) return { status:'FORBIDDEN' };
  email = String(email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return { status:'BAD_EMAIL' };
  var list = getDynamicSuperUsers_();
  // Bootstrap admins are already super; do not duplicate them in properties.
  if (SUPER_USERS.indexOf(email) === -1 && list.indexOf(email) === -1) {
    list.push(email);
    PropertiesService.getScriptProperties().setProperty(SUPER_ADMIN_PROP, JSON.stringify(list));
  }
  return { status:'OK', admins:getSuperUsers_() };
}

/** Super-core-only: revoke a Settings-managed Super Core Admin. */
function revokeSuperAdmin(email, viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!isSuperUser_(ctx.email)) return { status:'FORBIDDEN' };
  email = String(email || '').toLowerCase().trim();
  // Keep the bootstrap owners in code as a recovery path.
  if (SUPER_USERS.indexOf(email) !== -1) return { status:'LOCKED', admins:getSuperUsers_() };
  var list = getDynamicSuperUsers_().filter(function(e){ return e !== email; });
  PropertiesService.getScriptProperties().setProperty(SUPER_ADMIN_PROP, JSON.stringify(list));
  return { status:'OK', admins:getSuperUsers_() };
}

// The web app runs as the deploying account (so nobody else is asked for
// permissions and every lead list lands in the owner's Drive folder). In that
// mode Session.getActiveUser() can be empty, so the page tells us who it is:
// doGet() reads the viewer's email from the request and stores it on the
// template, and the front-end sends it back with each call.
var __VIEWER_EMAIL = '';
var __CTX_MEMO = null;   // per-execution cache for getUserContext()
var __VIEW_AS_KAM = '';  // validated per-request preview chosen in Settings

function setViewer_(email) {
  email = String(email || '').toLowerCase().trim();
  if (email && email.indexOf('@') !== -1) { __VIEWER_EMAIL = email; __CTX_MEMO = null; __AMTL_MEMO = null; }
}

function setViewAsKam_(email) {
  email = String(email || '').toLowerCase().trim();
  if (email !== __VIEW_AS_KAM) {
    __VIEW_AS_KAM = email;
    __CTX_MEMO = null;
    __AMTL_MEMO = null;
    __RESOLVED_FOLDER = null;
    __RESOLVED_FOR = null;
  }
}

function getUserContext() {
  if (__CTX_MEMO) return __CTX_MEMO;
  var actualEmail = __VIEWER_EMAIL;
  if (!actualEmail) {
    try { actualEmail = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (e) {}
  }
  if (!actualEmail) {
    try { actualEmail = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim(); } catch (e) {}
  }
  if (!actualEmail) return { email: "", actualEmail:"", isAdmin: false, actualIsAdmin:false, role: 'unknown', kams: [], resView: false };

  var granted = isGranted_(actualEmail);
  var rv = {};
  try { rv = resolveViewer_(actualEmail, (typeof __CLUSTER_OVERRIDE !== 'undefined') ? __CLUSTER_OVERRIDE : ''); } catch (e) { rv = {}; }
  var email = String(rv.email || actualEmail).toLowerCase();
  var viewingAs = !!rv.viewAsKam;

  // "isAdmin" = sees everything in the current folder scope: super users,
  // Settings-granted users, and cluster CEOs (whole cluster) all qualify.
  // In preview mode it intentionally becomes false so all data goes through
  // the selected KAM's normal portfolio filter.
  var actualIsAdmin = isSuperUser_(actualEmail) || granted ||
                      (!viewingAs && (rv.role === 'super' || rv.role === 'ceo'));
  var isAdmin = !viewingAs && actualIsAdmin;

  __CTX_MEMO = {
    email: email, actualEmail:actualEmail, isAdmin: isAdmin,
    actualIsAdmin:actualIsAdmin, isSuper:isSuperUser_(actualEmail), isViewingAs:viewingAs, viewAsKam:rv.viewAsKam || '',
    role: rv.role || 'unknown', cluster: rv.cluster || '',
    kams: rv.kams || [], resView: rv.resView !== false
  };
  return __CTX_MEMO;
}

// Leaderboard columns are located by header name, not by spreadsheet position.
// This sheet is business-maintained and columns can be inserted/reordered.
function leaderboardHeaderKey_(value) {
  return String(value || '').toLowerCase()
    .replace(/[_\r\n]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function leaderboardColumn_(headers, aliases) {
  var keys = headers.map(leaderboardHeaderKey_);
  var wanted = aliases.map(leaderboardHeaderKey_);
  for (var a = 0; a < wanted.length; a++) {
    var exact = keys.indexOf(wanted[a]);
    if (exact !== -1) return exact;
  }
  // Supports descriptive headers such as "Cluster Name (Sourab)".
  for (var b = 0; b < wanted.length; b++) {
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(wanted[b]) !== -1) return i;
    }
  }
  return -1;
}

// The business team occasionally adds a suffix / space to the Scorecard tab.
// Prefer its exact configured name, then locate the appropriate Scorecard by
// words so the dashboard never silently loses every rank after a tab rename.
function leaderboardScorecardSheet_(ss, source, audience) {
  var isZh = String(audience || 'kam').toLowerCase() === 'zh';
  var wanted = source === 'india'
    ? (isZh ? LEADERBOARD_INDIA_ZH_TAB : LEADERBOARD_INDIA_TAB)
    : (isZh ? LEADERBOARD_BHARAT_ZH_TAB : LEADERBOARD_BHARAT_TAB);
  var exact = ss.getSheetByName(wanted);
  if (exact) return exact;
  var token = source === 'india' ? 'india' : 'bharat';
  var audienceToken = isZh ? 'zh' : 'kam';
  var sheets = ss.getSheets();
  for (var i=0;i<sheets.length;i++) {
    var key = leaderboardHeaderKey_(sheets[i].getName());
    if (key.indexOf(token + ' ' + audienceToken) !== -1 && key.indexOf('scorecard') !== -1) return sheets[i];
  }
  return null;
}

// Read the business-maintained quarterly rank sheets. The published India and
// Bharat tabs have different rank columns, so the source is selected from the
// viewer's active cluster and every confirmed business column is mapped here.
function getQuarterlyLeaderboard(viewer, clusterOverride) {
  setViewer_(viewer);
  setClusterOverride_(clusterOverride || '');
  var context = getUserContext();
  var email = String(context.email || viewer || '').trim().toLowerCase();
  var rv = resolveViewer_(email, clusterOverride || '');
  var isZhViewer = String(rv.role || context.role || '').toLowerCase() === 'zh';
  var targetCluster = (rv.role === 'super' && !clusterOverride) ? '' : clusterKey_(rv.cluster || '');
  var indiaKeys = INDIA_LEADERBOARD_CLUSTERS.map(clusterKey_);
  var useIndia = !!targetCluster && indiaKeys.indexOf(targetCluster) !== -1;
  function asRank_(v) {
    var n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g,''), 10);
    return isFinite(n) && n > 0 ? n : null;
  }
  function asNumber_(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[, %]/g,'')); return isFinite(n) ? n : null; }
  // Sheets stores percentage-formatted cells as decimal values (1.053 for
  // 105.3%). Dashboard rank metrics must always be rendered as percentage
  // points, while the business score itself remains an absolute score.
  function asPercent_(v) {
    var n = asNumber_(v);
    return n != null && Math.abs(n) <= 1 ? n * 100 : n;
  }
  function displayName_(mail) {
    var local = String(mail || '').split('@')[0];
    return local.split(/[._-]+/).filter(function(x){ return !!x; }).map(function(x){
      return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
    }).join(' ') || 'Unknown';
  }
  function imageUrl_(v) {
    var raw = String(v || '').trim();
    if (!raw) return '';
    // Google Drive sharing links do not always render in an <img>; turn them
    // into a direct-view URL while leaving ordinary HTTPS image URLs untouched.
    var m = raw.match(/[-\w]{25,}/);
    if (raw.indexOf('drive.google.com') !== -1 && m) return 'https://drive.google.com/uc?export=view&id=' + m[0];
    return raw;
  }
  try {
    var ss = SpreadsheetApp.openById(LEADERBOARD_SHEET_ID);
    var source = useIndia ? 'india' : 'bharat';
    var sh = leaderboardScorecardSheet_(ss, source, isZhViewer ? 'zh' : 'kam');
    if (!sh) return { status:'NO_DATA', message:(useIndia ? 'India' : 'Bharat') + ' ' + (isZhViewer ? 'ZH' : 'KAM') + ' leaderboard tab not found.' };
    var values = sh.getDataRange().getValues();
    if (values.length < 2) return { status:'NO_DATA', message:'Leaderboard has no rows yet.' };
    // Zero-based locations from the confirmed JAS'26 formats. Header names
    // are business-managed, while these letters are the stable source contract.
    // JAS'26 Scorecard source contract (zero-based indexes). These are score
    // cards, not the earlier Leaderboard tabs, and intentionally have no KAM
    // image field. Bharat carries NOV / WS / Chalo 49 / Acquisition ranks;
    // India carries NOV / CM ranks.
    var col = useIndia
      ? { email:0, cluster:1, novAch:5, cmAch:8, novCluster:9, cmCluster:10,
          novIndia:11, cmIndia:12, overallScore:13, overallCluster:14, charter:15 }
      : { email:0, cluster:1, novAch:5, ws:8, chalo:11,
          novCluster:13, wsCluster:14, chaloCluster:15, acqCluster:16,
          novBharat:17, wsBharat:18, chaloBharat:19, acqBharat:20,
          overallScore:21, overallRank:22, charter:23 };

    var allRows = [];
    for (var i=1; i<values.length; i++) {
      var row = values[i];
      var kamEmail = String(row[col.email] || '').trim().toLowerCase();
      if (!kamEmail || kamEmail.indexOf('@') === -1) continue;
      var rowClusterKey = clusterKey_(row[col.cluster] || '');
      if (useIndia && indiaKeys.indexOf(rowClusterKey) === -1) continue;
      var rank = useIndia
        ? { overallCluster:asRank_(row[col.overallCluster]), novCluster:asRank_(row[col.novCluster]),
            cmCluster:asRank_(row[col.cmCluster]), novIndia:asRank_(row[col.novIndia]),
            cmIndia:asRank_(row[col.cmIndia]), charter:asRank_(row[col.charter]) }
        : { overallRank:asRank_(row[col.overallRank]), charter:asRank_(row[col.charter]),
            novCluster:asRank_(row[col.novCluster]), wsCluster:asRank_(row[col.wsCluster]),
            chaloCluster:asRank_(row[col.chaloCluster]), acqCluster:asRank_(row[col.acqCluster]),
            novBharat:asRank_(row[col.novBharat]), wsBharat:asRank_(row[col.wsBharat]),
            chaloBharat:asRank_(row[col.chaloBharat]), acqBharat:asRank_(row[col.acqBharat]) };
      if (!Object.keys(rank).some(function(k){ return rank[k] != null; })) continue;
      allRows.push({
        email: kamEmail,
        name: displayName_(kamEmail),
        image: '',
        cluster: String(row[col.cluster] || '').trim(),
        clusterKey: rowClusterKey,
        novAch:asPercent_(row[col.novAch]), cmAch:asPercent_(row[col.cmAch]),
        ws:useIndia ? null : asPercent_(row[col.ws]), chalo:useIndia ? null : asPercent_(row[col.chalo]),
        overallScore:asNumber_(row[col.overallScore]),
        overallAchievementScore:null,
        rank:rank
      });
    }
    // Cluster ranks are scoped to the selected cluster. India/Bharat ranks
    // remain source-wide so a KAM can compare against the correct arena.
    var clusterRows = targetCluster ? allRows.filter(function(r){ return r.clusterKey === targetCluster; }) : allRows.slice();
    var mine = (targetCluster ? clusterRows : allRows).filter(function(r){ return r.email === email; })[0] || allRows.filter(function(r){ return r.email === email; })[0] || null;
    // A ZH/TL should see only their own position. Rank values still come from
    // the full official scorecard, so # remains their true Bharat/India or
    // cluster rank without exposing any other ZH/TL's details.
    if (isZhViewer) {
      allRows = mine ? [mine] : [];
      clusterRows = mine ? [mine] : [];
    }
    return {
      status:'OK', quarter:"JAS'26", source:source, sourceLabel:useIndia?'India':'Bharat', cluster:rv.cluster || '', sourceTab:sh.getName(),
      role:context.role || rv.role || '', viewerOnly:isZhViewer, clusterRows:clusterRows, allRows:allRows, mine:mine, viewerEmail:email,
      availableMetrics:useIndia ? ['overall','nov','cm'] : ['overall','nov','ws','chalo','acq']
    };
  } catch (e) {
    return { status:'ERROR', message:String(e) };
  }
}

// Run manually from Apps Script if a business scorecard changes again. This
// is read-only and shows the exact source tab, record count, and rank counts.
function diagnoseQuarterlyLeaderboard() {
  var ss = SpreadsheetApp.openById(LEADERBOARD_SHEET_ID), out = {};
  ['bharat','india'].forEach(function(source){
    var sh = leaderboardScorecardSheet_(ss, source);
    if (!sh) { out[source] = { found:false }; return; }
    var rows = sh.getDataRange().getValues(), cols = source === 'india'
      ? { overall:14, charter:15, novCluster:9, cmCluster:10, novNational:11, cmNational:12 }
      : { overall:22, charter:23, novCluster:13, wsCluster:14, chaloCluster:15, acqCluster:16, novNational:17, wsNational:18, chaloNational:19, acqNational:20 };
    var counts = {}; Object.keys(cols).forEach(function(k){ counts[k] = 0; });
    for (var i=1;i<rows.length;i++) Object.keys(cols).forEach(function(k){ if (String(rows[i][cols[k]] || '').trim()) counts[k]++; });
    out[source] = { found:true, tab:sh.getName(), rows:Math.max(0,rows.length-1), rankCells:counts };
  });
  Logger.log(JSON.stringify(out));
  return out;
}

// =========================================================
// USAGE TRACKER  (logs to a Google Sheet: Events + Sessions tabs)
// Called silently from the client. Never throws to the caller.
// =========================================================
function trackerSheet_(name) {
  var ss = SpreadsheetApp.openById(TRACKER_SHEET_ID);
  // keep the sheet's timezone aligned with the script so stored dates and
  // new Date() never drift apart.
  try { if (ss.getSpreadsheetTimeZone() !== Session.getScriptTimeZone()) ss.setSpreadsheetTimeZone(Session.getScriptTimeZone()); } catch (e) {}
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (name === 'Events') {
      sh.appendRow(['Timestamp', 'Email', 'Session ID', 'Event', 'Detail']);
    } else if (name === 'Sessions') {
      sh.appendRow(['Email', 'Session ID', 'Login Time', 'Last Active', 'Duration (min)', 'Tab Views', 'Refreshes', 'LoginMs']);
    } else if (name === 'Locations') {
      sh.appendRow(['Timestamp', 'Email', 'Session ID', 'Latitude', 'Longitude', 'Accuracy (m)', 'Status', 'Source', 'Google Maps Link']);
    }
  }
  return sh;
}

// Browser location tracker. The browser asks the viewer for permission; when
// permission is denied we retain only that status, never a guessed IP location.
// One row is kept per browser session so a refresh does not inflate the tracker.
function logClientLocation(location, sessionId) {
  try {
    location = location || {};
    var ctx = getUserContext();
    // Availability belongs to the real signed-in actor, never to a KAM being
    // previewed through View-as mode by an Admin/ZH/CEO.
    var email = ctx.actualEmail || ctx.email || 'unknown';
    sessionId = sessionId || 'na';
    var status = String(location.status || 'Unavailable');
    var lat = Number(location.latitude);
    var lng = Number(location.longitude);
    var accuracy = Number(location.accuracy);
    if (!isFinite(lat) || Math.abs(lat) > 90) lat = '';
    if (!isFinite(lng) || Math.abs(lng) > 180) lng = '';
    if (!isFinite(accuracy) || accuracy < 0) accuracy = '';
    var source = String(location.source || 'browser_geolocation');
    var mapLink = (lat !== '' && lng !== '') ? 'https://www.google.com/maps?q=' + lat + ',' + lng : '';
    var sh = trackerSheet_('Locations');
    var data = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][2]) === String(sessionId)) { rowIdx = i + 1; break; }
    }
    var row = [new Date(), email, sessionId, lat, lng, accuracy, status, source, mapLink];
    if (rowIdx === -1) sh.appendRow(row);
    else sh.getRange(rowIdx, 1, 1, row.length).setValues([row]);
    return true;
  } catch (e) {
    return false;
  }
}

// Main entry from the client. eventType: 'login' | 'tab' | 'heartbeat' | 'refresh'
// detail: free text (e.g. tab name). sessionId: client-generated per load.
function logEvent(eventType, detail, sessionId) {
  try {
    var ctx = getUserContext();
    var email = ctx.email || 'unknown';
    var now = new Date();
    sessionId = sessionId || 'na';
    detail = detail || '';

    // 1) detailed events row (skip heartbeats to keep the log clean)
    if (eventType !== 'heartbeat') {
      trackerSheet_('Events').appendRow([now, email, sessionId, eventType, detail]);
    }

    // 2) session summary (upsert by Session ID)
    var sh = trackerSheet_('Sessions');
    var data = sh.getDataRange().getValues();   // includes header
    var rowIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === String(sessionId)) { rowIdx = i + 1; break; }  // 1-based
    }
    var nowMs = now.getTime();
    if (rowIdx === -1) {
      // new session — store login epoch (ms) in a hidden 8th column for tz-safe math
      var tabViews = (eventType === 'tab') ? 1 : 0;
      var refreshes = (eventType === 'refresh') ? 1 : 0;
      sh.appendRow([email, sessionId, now, now, 0, tabViews, refreshes, nowMs]);
    } else {
      // prefer the stored epoch (col 8) — immune to any spreadsheet/script
      // timezone mismatch. Fall back to the Login-Time cell only if missing.
      var loginMs = Number(data[rowIdx - 1][7]);
      if (!loginMs || isNaN(loginMs)) {
        var lt = data[rowIdx - 1][2];
        loginMs = (lt instanceof Date) ? lt.getTime() : new Date(lt).getTime();
      }
      var durMin = Math.round((nowMs - loginMs) / 60000);
      // clamp: never negative, and cap a single session at 8h (anything larger
      // is a clock/tz artefact, not real usage)
      if (durMin < 0) durMin = 0;
      if (durMin > 480) durMin = 480;
      var tabViews = Number(data[rowIdx - 1][5]) || 0;
      var refreshes = Number(data[rowIdx - 1][6]) || 0;
      if (eventType === 'tab') tabViews++;
      if (eventType === 'refresh') refreshes++;
      // write Last Active, Duration, Tab Views, Refreshes (cols 4-7); keep epoch in col 8
      sh.getRange(rowIdx, 4, 1, 4).setValues([[now, durMin, tabViews, refreshes]]);
    }
    return true;
  } catch (e) {
    return false;   // never break the app over logging
  }
}

// =========================================================
// DRIVE HELPERS
// =========================================================
// The data folder for THIS request. If the viewer routes to a cluster folder
// via the master sheet, use that; otherwise fall back to the legacy folder so
// nothing breaks before the master sheet is fully populated.
var __RESOLVED_FOLDER = null;
var __RESOLVED_FOR = null;
function getCacheFolder() {
  var email = __VIEWER_EMAIL || getCurrentEmail_();
  var ov = (typeof __CLUSTER_OVERRIDE !== 'undefined') ? __CLUSTER_OVERRIDE : '';
  var key = email + '|' + ov;
  if (__RESOLVED_FOLDER && __RESOLVED_FOR === key) return __RESOLVED_FOLDER;
  var folder = null;
  try {
    var rv = resolveViewer_(email, ov);
    if (rv && rv.folderId) folder = DriveApp.getFolderById(rv.folderId);
  } catch (e) { folder = null; }
  // No legacy ROM fallback: this app is now purely master-routed.
  __RESOLVED_FOLDER = folder;
  __RESOLVED_FOR = key;
  __FOLDER_INDEX = null; __FILE_CACHE = {};
  return folder;
}

// Validate the data contract before a full dashboard parse. This prevents a
// newly mapped cluster from being retried forever behind the 99% loader when
// its folder is missing, empty, or contains only files Apps Script cannot read.
function clusterLoadHealth_(email, clusterOverride, requestedPeriod) {
  var rv = resolveViewer_(email, clusterOverride || '');
  var folder = getCacheFolder();
  var label = String((rv && rv.cluster) || clusterOverride || 'this cluster');
  if (!folder) return { ok:false, message:'No data folder is mapped for ' + label + '. Add a valid folder_id in the master sheet.' };
  var required = ['Nov_day','Nov_week','Nov_month','Nov_quarter'];
  var found = {}, oversized = [];
  try {
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next(), name = String(f.getName() || ''), low = name.toLowerCase();
      if (low.slice(-4) !== '.csv') continue;
      required.forEach(function(base){
        var b = base.toLowerCase();
        if (low === b + '.csv' || low.indexOf(b + '_') === 0) {
          found[base] = name;
          if (Number(f.getSize()) > MAX_CSV_TEXT_READ_BYTES) oversized.push(name);
        }
      });
    }
  } catch (e) {
    return { ok:false, message:'The mapped ' + label + ' folder could not be read. Give the Apps Script owner access to it.' };
  }
  var requestedBase = NOV_FILE[requestedPeriod === 'lastweek' ? 'day' : requestedPeriod];
  if (requestedBase && !found[requestedBase]) {
    return { ok:false, message:'The selected ' + requestedPeriod + ' view needs ' + requestedBase + ' CSV in the ' + label + ' folder.' };
  }
  if (requestedBase && oversized.indexOf(found[requestedBase]) !== -1) {
    return { ok:false, message:label + ' ' + found[requestedBase] + ' is over the 45 MB Apps Script limit. Split or compact this file before opening ' + requestedPeriod + ' view.' };
  }
  var readable = required.filter(function(base){ return found[base] && oversized.indexOf(found[base]) === -1; });
  if (!readable.length) {
    if (oversized.length) return { ok:false, message:label + ' CSV is over the 45 MB Apps Script limit: ' + oversized.join(', ') + '. Split or compact this file.' };
    return { ok:false, message:'No NOV period CSV was found in the ' + label + ' folder. Expected Nov_day, Nov_week, Nov_month or Nov_quarter CSV files.' };
  }
  return { ok:true, folder:folder.getName(), readable:readable, missing:required.filter(function(base){ return !found[base]; }) };
}
var __CLUSTER_OVERRIDE = '';
// Diagnostic: what does the app resolve for a viewer? Run from the editor or
// call from the client to debug "no data" issues.
function debugResolve(viewer, clusterOverride) {
  setClusterOverride_(clusterOverride || '');
  setViewer_(viewer);
  var email = String(viewer||'').trim().toLowerCase() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride || '');
  var folder = null, folderName = '', files = [];
  try {
    folder = getCacheFolder();
    if (folder) {
      folderName = folder.getName();
      var it = folder.getFiles(), n = 0;
      while (it.hasNext() && n < 40) { files.push(it.next().getName()); n++; }
    }
  } catch (e) {}
  var probes = {};
  ['current_month','last_month','amtl','Nov_day','Nov_month','price_parity_lead_list'].forEach(function(b){
    var hit = readClusterFile_(folder, b);
    probes[b] = hit ? hit.name : 'NOT FOUND';
  });

  // AMTL join diagnostics
  var amtl = {};
  try { amtl = loadAmtl_(email, clusterOverride || ''); } catch(e) {}
  var amtlCount = Object.keys(amtl).length;
  var sampleAmtlIds = Object.keys(amtl).slice(0, 5);
  // sample res_ids from the day NOV file and whether they join
  var novIds = [], joined = 0, novTotal = 0;
  try {
    var nf = readForViewer_(email, NOV_FILE.day, clusterOverride || '');
    if (nf) {
      var rows = csvToObjects_(nf.csv);
      novTotal = rows.length;
      rows.slice(0, 200).forEach(function(r){
        var id = normId_(r.res_id);
        if (novIds.length < 5) novIds.push(id);
        if (amtl[id]) joined++;
      });
    }
  } catch(e) {}

  return {
    email: email, role: rv.role, cluster: rv.cluster, clusterKey: rv.clusterKey,
    folderId: rv.folderId, folderName: folderName, isSuper: rv.isSuper,
    kams: rv.kams, filesInFolder: files, probes: probes,
    masterRows: loadMaster_().length,
    amtlCount: amtlCount, sampleAmtlIds: sampleAmtlIds,
    novRows: novTotal, sampleNovIds: novIds, joinedInFirst200: joined,
    bakedIgnored: (function(){ try { return readBaked_() ? 'used' : 'ignored/absent'; } catch(e){ return 'err'; } })()
  };
}

function setClusterOverride_(v){ if (v !== __CLUSTER_OVERRIDE) { __CLUSTER_OVERRIDE = v || ''; __RESOLVED_FOLDER = null; __CTX_MEMO = null; __AMTL_MEMO = null; } }

// Case-insensitive read: exact name first, then a scan fallback.
// Folder index, built once per execution. Repeated lookups (we probe up to 8
// dates x 2 naming styles per period) then cost nothing instead of rescanning
// the whole folder on every miss.
var __FOLDER_INDEX = null;
function folderIndex_() {
  if (__FOLDER_INDEX) return __FOLDER_INDEX;
  var idx = {};
  try {
    var it = getCacheFolder().getFiles();
    while (it.hasNext()) {
      var f = it.next();
      idx[f.getName().toLowerCase()] = f;
    }
  } catch (e) {}
  __FOLDER_INDEX = idx;
  return idx;
}

var __FILE_CACHE = {};
function readFileByName(filename) {
  try {
    var key = String(filename).toLowerCase();
    if (__FILE_CACHE.hasOwnProperty(key)) return __FILE_CACHE[key];
    var f = folderIndex_()[key];
    var out = f ? f.getBlob().getDataAsString() : null;
    __FILE_CACHE[key] = out;      // same file is often needed by several steps
    return out;
  } catch (e) {
    return null;
  }
}

// True if the file exists, without downloading it. Used to find the right
// dated file cheaply before reading it.
function fileExists_(filename) {
  try { return !!folderIndex_()[String(filename).toLowerCase()]; }
  catch (e) { return false; }
}

// Read the NOV period file (Nov_day/week/month/quarter) for the viewer's cluster.
// Returns { csv, fileDate, name } or null.
// Resolve the preferred base file name for the current viewer. Super Core uses
// the explicit map because 2_month and price-parity are intentionally unsuffixed.
function baseForViewer_(base) {
  var rv = resolveViewer_(__VIEWER_EMAIL || getCurrentEmail_(), __CLUSTER_OVERRIDE);
  var superCore = rv.isSuper && (!__CLUSTER_OVERRIDE || __CLUSTER_OVERRIDE === '' || __CLUSTER_OVERRIDE === 'super_core_admin');
  if (!superCore) return base;
  return superCoreFileCandidates_(base)[0] || base;
}
// Read a base file for the current viewer using the Super Core nomenclature.
function readViewerBase_(base) {
  var rv = resolveViewer_(__VIEWER_EMAIL || getCurrentEmail_(), __CLUSTER_OVERRIDE);
  var folder = getCacheFolder();
  var superCore = rv.isSuper && (!__CLUSTER_OVERRIDE || __CLUSTER_OVERRIDE === '' || __CLUSTER_OVERRIDE === 'super_core_admin');
  if (superCore) {
    var hitS = readSuperCoreFile_(folder, base, rv.clusterKey);
    if (hitS && hitS.csv) return hitS;
  }
  return readClusterFile_(folder, base, rv.clusterKey);
}

function readPeriodFile(period) {
  var base = NOV_FILE[period];
  if (!base) return null;
  var hit = readViewerBase_(base);
  if (hit && hit.csv) return { csv: hit.csv, fileDate: hit.fileDate || new Date().toISOString(), name: hit.name };
  return null;
}

// Last WHOLE month comparison table (same columns as the current-month table).
function readLastMetricFile_(period) {
  if (period === 'week') {
    var weekly = readViewerBase_(TABLE_WEEK_FILE);
    return weekly && weekly.csv ? { csv: weekly.csv, fileDate: new Date().toISOString(), name: weekly.name } : null;
  }
  var hit = readViewerBase_(TABLE_LAST_FILE);
  if (hit && hit.csv) return { csv: hit.csv, fileDate: new Date().toISOString(), name: hit.name };
  return null;
}

// Endpoint: last-period comparison metrics for ONE restaurant.
// Compares against last WHOLE month; peers from the current-month table.
function getLastMetrics(period, resId, viewer, clusterOverride, viewAsKam) {
  // Mirror the active dashboard context. Without this, a Super/CEO "View as
  // KAM" deep dive can read history from the caller's folder instead of the
  // selected KAM's cluster, leaving LM/L2M empty.
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var context = getUserContext();
  resId = String(resId || '').trim();
  if (!resId) return { status:'NO_ID' };

  var out = { status:'OK', period:period, resId:resId, metrics:null, peer:null };

  var f = readLastMetricFile_(period);
  if (f) {
    var lastMap = period === 'week' ? parseMetricsWeek_(f.csv, 1) : parseMetrics(f.csv);
    out.metrics = lastMap[resId] || null;
  }

  // Mo2M / Mo3M for this res (same table schema), for the deep-dive trend.
  try {
    var f2 = period === 'week' ? readViewerBase_(TABLE_WEEK_FILE) : readViewerBase_(TABLE_2MONTH_FILE);
    if (f2) { var m2 = period === 'week' ? parseMetricsWeek_(f2.csv, 2) : parseMetrics(f2.csv); out.metrics2 = m2[resId] || null; }
    var f3 = period === 'week' ? readViewerBase_(TABLE_WEEK_FILE) : readViewerBase_(TABLE_3MONTH_FILE);
    if (f3) { var m3 = period === 'week' ? parseMetricsWeek_(f3.csv, 3) : parseMetrics(f3.csv); out.metrics3 = m3[resId] || null; }
  } catch (e) {}

  // Peer benchmarks from the CURRENT metrics table.  Deep-dive benchmarks are
  // deliberately role-independent: every restaurant is compared only with
  // restaurants in the same Cuisine × City cohort.  Do not fall back to a
  // city-wide cohort when cuisine is absent, otherwise unrelated cuisines get
  // the identical B.Avg / B.Max values (especially visible for Ads metrics).
  try {
    var cf = readMetricFile(period);
    if (cf) {
      var curMap = period === 'week' ? parseMetricsWeek_(cf.csv, 0) : parseMetrics(cf.csv);
      var me = curMap[resId];
      if (me) {
        out.current = me;
        // AMTL is the reliable relational source for city/cuisine.  Current
        // metric exports can occasionally omit either field, so enrich both
        // the selected restaurant and its peers before applying the cohort.
        var peerAmtl = loadAmtl_(context.actualEmail || context.email || viewer, clusterOverride || '');
        var mineAmtl = peerAmtl[normId_(resId)] || {};
        // Build one canonical cohort key and use that exact key for every
        // benchmarked metric.  Keeping this as a single key prevents one
        // section (Ads, Funnel, Discounts, etc.) from accidentally using a
        // city-only population while another uses Cuisine x City.
        var cohortPart_ = function(value){
          return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        };
        var myCuisine = cohortPart_(me.cuisine || mineAmtl.cuisine || '');
        var myCity    = cohortPart_(me.city || mineAmtl.city || '');
        var myCohortKey = myCity && myCuisine ? myCity + '||' + myCuisine : '';
        var bench = { mvdSv:[], zvdSv:[], tvdSv:[], saltSv:[], adsCv:[], adsSv:[], commissionSv:[], walletShare:[], visibility:[], m2c:[], c2o:[], m2o:[], i2m:[], i2o:[], impressions:[], menuOpens:[], ovRms:[], impressionRms:[], merchantShare:[], actMshare:[], mShare:[], zShare:[], orders:[], sv:[], cv:[], asv:[], acv:[], novActual:[], novPerOrder:[], adsRoi:[], effBr:[], ineffBr:[], deliveryPct:[], billedAds:[], bauBilling:[], gmBilling:[], cpc:[], codedOv:[], saltOv:[], discountOv:[], mvdCoverage:[], peCoverage:[], saltCoverage:[], rating:[], menuScore:[], imageScore:[], descScore:[], newOrders:[], repeatOrders:[], lapsedOrders:[], pg710:[], pg46:[], pg13:[], breakfastOrders:[], lunchOrders:[], eveningOrders:[], dinnerOrders:[], lateNightOrders:[] };
        var n = 0;
        for (var k in curMap) {
          if (k === resId) continue;
          var p = curMap[k];
          var peerAmtlRow = peerAmtl[normId_(k)] || {};
          var peerCuisine = cohortPart_(p.cuisine || peerAmtlRow.cuisine || '');
          var peerCity = cohortPart_(p.city || peerAmtlRow.city || '');
          var peerCohortKey = peerCity && peerCuisine ? peerCity + '||' + peerCuisine : '';
          if (!myCohortKey || peerCohortKey !== myCohortKey) continue;
          // Beat Plan ratios use pure SV as the denominator. Packaging charges
          // remain a separate absolute metric and are never added to SV.
          var sv = p.sv || 0, cv = p.cv || 0;
          var pm = sv > 0 ? (p.mvdAmt / sv * 100) : parseFloat(p.actual_mvd_sv || 0);
          var pa = cv > 0 ? (p.ad_rev / cv * 100) : 0;
          var pz = sv > 0 ? (p.zvdAmt / sv * 100) : 0;
          var pt = sv > 0 ? ((p.zvdAmt + p.mvdAmt) / sv * 100) : 0;
          var ps = sv > 0 ? (p.saltAmt / sv * 100) : 0;
          var pas = sv > 0 ? (p.ad_rev / sv * 100) : 0;
          var pws = sv > 0 ? ((p.mvdAmt + p.ad_rev + p.commissionRevenue + p.saltAmt) / sv * 100) : 0;
          var po = p.total_orders || 0, pim=p.impressions || 0, pmo=p.menuOpens || 0, pom=p.orderMakes || 0;
          var pv = p.expected > 0 ? (p.actual / p.expected * 100) : 0;
          var add = function(key, value){ if (isFinite(value) && value > 0 && bench[key]) bench[key].push(value); };
          add('mvdSv',pm); add('zvdSv',pz); add('tvdSv',pt); add('saltSv',ps); add('adsCv',pa); add('adsSv',pas); add('walletShare',pws); add('visibility',pv);
          add('m2c',parseFloat(p.m2c||0)); add('c2o',parseFloat(p.c2o||0)); add('m2o',parseFloat(p.m2o||0));
          add('i2m',pim>0?pmo/pim*100:0); add('i2o',pim>0?pom/pim*100:0); add('impressions',pim); add('menuOpens',pmo);
          add('ovRms',parseFloat(p.ovRms||0)); add('impressionRms',parseFloat(p.impressionRms||0));
          var pNov = parseFloat(p.novActual || p.novValue || 0);
          add('orders',po); add('sv',sv); add('cv',cv); add('asv',po>0?sv/po:0); add('acv',po>0?cv/po:0);
          add('commissionSv',sv>0?(p.commissionRevenue||0)/sv*100:0); add('novActual',pNov); add('novPerOrder',po>0?pNov/po:0);
          // Sharing is defined by actual merchant share from merchant_discount;
          // Z-share is always its complement.  Older feeds may use a decimal.
          var pMshare = parseFloat(p.actual_mshare || 0);
          if (pMshare > 0 && pMshare <= 1) pMshare *= 100;
          var pZshare = pMshare > 0 ? Math.max(0, 100 - pMshare) : 0;
          add('mShare',pMshare); add('zShare',pZshare); add('adsRoi',p.adsRoi||0); add('effBr',p.effBr||0); add('ineffBr',p.ineffBr||0); add('deliveryPct',p.deliveryPct||0); add('billedAds',p.billedAds||0); add('bauBilling',p.bauBilling||0); add('gmBilling',p.gmBilling||0); add('cpc',p.cpc||0);
          // MVD OV is the source field for Coded OV in the new CSV schema.
          var pCodedOv = po>0 ? (p.mvdOv||0)/po*100 : 0;
          var pSaltOv = po>0 ? (p.saltOrders||0)/po*100 : 0;
          add('codedOv',pCodedOv); add('saltOv',pSaltOv); add('discountOv',pCodedOv+pSaltOv); add('mvdCoverage',pCodedOv); add('peCoverage',p.pe===1?100:0); add('saltCoverage',pSaltOv);
          add('merchantShare',parseFloat(p.actual_mshare||0)); add('actMshare',parseFloat(p.actual_mshare||0)); add('rating',parseFloat(p.rating||0));
          add('menuScore',parseFloat(p.menuScore||0)); add('imageScore',parseFloat(p.imageScore||0)); add('descScore',parseFloat(p.descScore||0));
          // Customer segmentation is displayed as share of a restaurant's orders,
          // so peer Avg/Max must use the same percentage basis.
          add('newOrders',po>0?(p.newOrders||0)/po*100:0); add('repeatOrders',po>0?(p.repeatOrders||0)/po*100:0); add('lapsedOrders',po>0?(p.lapsedOrders||0)/po*100:0);
          add('pg710',po>0?(p.pg710||0)/po*100:0); add('pg46',po>0?(p.pg46||0)/po*100:0); add('pg13',po>0?(p.pg13||0)/po*100:0);
          add('breakfastOrders',po>0?(p.breakfastOrders||0)/po*100:0); add('lunchOrders',po>0?(p.lunchOrders||0)/po*100:0); add('eveningOrders',po>0?(p.eveningOrders||0)/po*100:0); add('dinnerOrders',po>0?(p.dinnerOrders||0)/po*100:0); add('lateNightOrders',po>0?(p.lateNightOrders||0)/po*100:0);
          n++;
        }
        var stats = function(a){
          if (!a.length) return null;
          var s = 0, mx = 0;
          for (var i=0;i<a.length;i++){ s += a[i]; if (a[i] > mx) mx = a[i]; }
          return { avg: s/a.length, max: mx, n: a.length };
        };
        var summary = {}, aliases = { mvdSv:'mvdSv', adsCv:'adsCv' };
        Object.keys(bench).forEach(function(key){ summary[key] = stats(bench[key]); });
        out.peer = { cuisine: me.cuisine || mineAmtl.cuisine || '', city: me.city || mineAmtl.city || '', peers:n,
          benchmarkScope:'Cuisine × City',
          benchmarks:summary, mvdSv:summary.mvdSv, adsCv:summary.adsCv };
      }
    }
  } catch (e) { /* peer benchmark is best-effort */ }

  return out;
}

// Endpoint: comparison maps for a Portfolio City / ZH / KAM roll-up.
// The browser already knows the exact restaurant IDs in the selected node, so
// return only those rows and let the same weighted roll-up be used for Now,
// MoM and Mo2M.  This avoids misleading unweighted portfolio comparisons.
function getPortfolioMetricComparisons(resIds, viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var wanted = {};
  (resIds || []).forEach(function(id){
    id = String(id || '').trim();
    if (id) wanted[id] = true;
  });
  function selected_(base) {
    var f = readViewerBase_(base), map = f ? parseMetrics(f.csv) : {}, out = {};
    Object.keys(wanted).forEach(function(id){ if (map[id]) out[id] = map[id]; });
    return out;
  }
  try {
    return { status:'OK', last:selected_(TABLE_LAST_FILE), mo2:selected_(TABLE_2MONTH_FILE) };
  } catch (e) {
    return { status:'ERROR', message:String(e) };
  }
}

// Metrics/table file = the current-month table for the viewer's cluster.
function readMetricFile(period) {
  var hit = readViewerBase_(period === 'week' ? TABLE_WEEK_FILE : TABLE_CUR_FILE);
  if (hit && hit.csv) return { csv: hit.csv, fileDate: new Date().toISOString(), name: hit.name };
  return null;
}

// Parse the metrics CSV into a { res_id: {..fields..} } map. Only the columns
// the table needs are kept; percentages are passed through as-is.
// Parsing the metrics CSV is the single most expensive step and several
// features need the same period. Memoise per execution.
var __METRICS_CACHE = {};
function parseMetricsCached_(period) {
  if (__METRICS_CACHE.hasOwnProperty(period)) return __METRICS_CACHE[period];
  var f = readMetricFile(period);
  var map = f ? (period === 'week' ? parseMetricsWeek_(f.csv, 0) : parseMetrics(f.csv)) : {};
  __METRICS_CACHE[period] = map;
  return map;
}

// `current_week` contains M, LW, L2W and L3W in one file. Keep parsing
// centralised so a restaurant's deep dive never accidentally uses an older
// row just because it occurred later in the CSV.
function parseMetricsWeek_(csvStr, offset) {
  if (!csvStr) return {};
  var lines = csvStr.replace(/\r/g,'').split('\n');
  if (lines.length < 2) return {};
  var delim = detectDelim(lines[0]), heads = splitLine(lines[0], delim).map(function(h){ return h.replace(/"/g,'').toLowerCase().trim(); });
  var ti = heads.indexOf('time_period');
  if (ti < 0) return parseMetrics(csvStr);
  var periods = {}, rows = [];
  for (var i=1;i<lines.length;i++) {
    if (!lines[i]) continue;
    var values = splitLine(lines[i], delim), p = String(values[ti] || '').replace(/^"|"$/g,'').trim();
    if (/^\d{4}-\d{1,2}$/.test(p)) periods[p] = true;
    rows.push({ raw:lines[i], period:p });
  }
  var keys = Object.keys(periods).sort(function(a,b){ var aa=a.split('-'), bb=b.split('-'); return (+bb[0]*100 + +bb[1]) - (+aa[0]*100 + +aa[1]); });
  var wanted = keys[offset || 0];
  if (!wanted) return {};
  return parseMetrics([lines[0]].concat(rows.filter(function(r){ return r.period === wanted; }).map(function(r){ return r.raw; })).join('\n'));
}

function parseMetrics(csvStr) {
  var map = {};
  if (!csvStr) return map;
  var lines = csvStr.replace(/\r/g,'').split('\n');
  if (lines.length < 2) return map;
  var delim = detectDelim(lines[0]);
  var H = splitLine(lines[0], delim).map(function(h){ return h.replace(/"/g,'').toLowerCase().trim(); });
  var idx = {}; for (var i=0;i<H.length;i++) idx[H[i]] = i;
  var col = function(v,n){ var k = idx[n]; return k===undefined ? "" : (v[k]||""); };
  var colFirst = function(v,names){
    for (var ci=0;ci<names.length;ci++) { var value = col(v,names[ci]); if (value !== '') return value; }
    return '';
  };
  // The deep-dive source keeps related measures together as JSON cells.  Parse
  // them once at ingestion, rather than teaching every renderer about CSV
  // quoting and every possible key spelling.
  var jsonCol = function(v, name){
    var raw = col(v,name);
    if (!raw) return {};
    try { return JSON.parse(String(raw)); } catch (ignore) { return {}; }
  };
  // JSON source keys have appeared both as snake_case and presentation labels
  // (for example "Intended MVD / SV + PC"). Resolve them safely by a
  // punctuation-insensitive lookup so a cosmetic CSV header/key change never
  // turns an intended value into zero on the dashboard.
  var jsonValue = function(obj, names){
    obj = obj || {}; names = names || [];
    var norm = function(x){ return String(x||'').toLowerCase().replace(/[^a-z0-9]/g,''); };
    for (var ni=0;ni<names.length;ni++) {
      if (obj[names[ni]] !== undefined && obj[names[ni]] !== null && obj[names[ni]] !== '') return obj[names[ni]];
      var wanted = norm(names[ni]);
      for (var key in obj) if (norm(key) === wanted && obj[key] !== '') return obj[key];
    }
    return '';
  };

  for (var r=1;r<lines.length;r++){
    if (!lines[r]) continue;
    var v = splitLine(lines[r], delim);
    for (var c=0;c<v.length;c++){ var pv=v[c]; if(pv&&pv.charAt(0)==='"'&&pv.charAt(pv.length-1)==='"') v[c]=pv.slice(1,-1).replace(/""/g,'"'); }
    var rid = String(col(v,'res_id')).trim();
    if (!rid) continue;
    var statusJ = jsonCol(v,'status_json'), visJ = jsonCol(v,'visibility_json'), hygJ = jsonCol(v,'hygiene_json');
    var pgJ = jsonCol(v,'pg_orders_json'), nrlJ = jsonCol(v,'nrl_orders_json'), mealJ = jsonCol(v,'mealtime_orders_json');
    var funnelJ = jsonCol(v,'funnel_metrics_json'), refundJ = jsonCol(v,'refund_json'), merchantJ = jsonCol(v,'merchent_discount');
    if (!Object.keys(merchantJ).length) merchantJ = jsonCol(v,'merchant_discount');
    var shareJ = jsonCol(v,'share'), adsJ = jsonCol(v,'ads_metrics');
    map[rid] = {
      nm: String(col(v,'res_name')||'').toLowerCase().trim(),   // name fallback (lowercase, for matching)
      nmDisp: String(col(v,'res_name')||'').trim(),             // display name
      city: String(col(v,'city')||'').trim(),
      cuisine: String(col(v,'cuisine')||'').trim(),
      am: String(col(v,'am_email')||'').toLowerCase().trim(),
      tl: String(col(v,'tl_email')||'').toLowerCase().trim(),
      subzone: String(col(v,'subzone_name')||'').trim(),
      pe:   parseNumG(col(v,'pe_status') || statusJ.PE_Status),        // 0/1
      salt: parseNumG(col(v,'salt_status') || statusJ.Salt_Status),      // 0/1
      mvdS: parseNumG(col(v,'mvd_status') || statusJ.Mvd_Status),       // 0/1
      peRaw:   col(v,'pe_status') || statusJ.PE_Status,                // raw, so blank != off
      saltRaw: col(v,'salt_status') || statusJ.Salt_Status,
      mvdSRaw: col(v,'mvd_status') || statusJ.Mvd_Status,
      adsFlag: colFirst(v,['ads_flag','ad_flag']) || jsonValue(statusJ,['ads_flag','ads']),
      arFlag: colFirst(v,['ar_flag','auto_renewal_flag']) || jsonValue(statusJ,['ar_flag','auto renewal']),
      gm1: colFirst(v,['gm1','gm_1','grow_maxx_1']) || jsonValue(statusJ,['gm1','gm_1']),
      gm2: colFirst(v,['gm2','gm_2','grow_maxx_2']) || jsonValue(statusJ,['gm2','gm_2']),
      gm3: colFirst(v,['gm3','gm_3','grow_maxx_3']) || jsonValue(statusJ,['gm3','gm_3']),
      sgm: colFirst(v,['sgm','super_grow_maxx']) || jsonValue(statusJ,['sgm','super_grow_maxx']),
      vegType: colFirst(v,['veg_type','food_type','veg_non_veg_flag']) || jsonValue(statusJ,['veg_type','food_type']),
      cartBreaker: colFirst(v,['cart_breaker','cart_breaker_flag','cartbreaker']) || jsonValue(statusJ,['cart_breaker','cartbreaker']),
      sv:   parseNumG(col(v,'sv')),               // for MVD/SV
      billSubtotal: parseNumG(colFirst(v,['bill_subtotal','z_subtotal','subtotal'])),
      mvdAmt: parseNumG(col(v,'mvd')),            // raw MVD amount
      zvdAmt: parseNumG(col(v,'zvd')),            // raw ZVD amount
      actual_mvd_sv:   col(v,'actual_mvd_sv') || col(v,'actual mvd/sv+pc') || col(v,'actual_mvd_sv+pc') || jsonValue(merchantJ,['actual_mvd_sv','actual mvd / sv + pc']),    // % (fallback if sv=0)
      intended_mvd_sv: col(v,'intended_mvd_sv') || col(v,'intended mvd/sv+pc') || jsonValue(merchantJ,['intended_mvd_sv','intended mvd / sv + pc']),  // %
      // Funnel fields are supplied both as flat columns and inside JSON.
      // jsonValue keeps these action-plan measures resilient to casing and
      // label variants ("I2M %", "M2C", "Cart to Order", etc.).
      m2c:  colFirst(v,['m2c','m2c_percent','menu_to_cart']) || jsonValue(funnelJ,['m2c','m2c_percent','menu_to_cart']),
      m2o:  colFirst(v,['m2o','m2o_percent','menu_to_order']) || jsonValue(funnelJ,['m2o','m2o_percent','menu_to_order']),
      c2o:  colFirst(v,['c2o','c2o_percent','cart_to_order']) || jsonValue(funnelJ,['c2o','c2o_percent','cart_to_order']),
      actual:   parseNumG(col(v,'actual') || visJ.actual),
      expected: parseNumG(col(v,'expected') || visJ.expected),
      actual_mshare:   col(v,'actual_mshare') || jsonValue(merchantJ,['actual_mshare','actual m-share','actual merchant share']),            // already %
      intended_mshare: colFirst(v,['intended_merchant_share','intended_merchent_share','intended_m_share','intended_mshare']) || jsonValue(merchantJ,['intended_merchant_share','intended_merchent_share','intended_m_share','intended m-share','intended merchant share']),  // already %
      total_orders: parseNumG(col(v,'total_orders')),
      ad_rev: parseNumG(col(v,'ad_rev')),
      cv: parseNumG(col(v,'commissionable_value')),
      novValue: parseNumG(colFirst(v,['nov','net_order_value','net order value'])),
      novActual: parseNumG(colFirst(v,['nov_actual','nov actual'])),
      commissionRevenue: parseNumG(col(v,'commission_revenue')),
      mxRefund: parseNumG(col(v,'mx_refund') || refundJ.mx_refund),
      cxRefund: parseNumG(col(v,'cx_refund') || refundJ.cx_refund),
      saltAmt: parseNumG(col(v,'salt')),
      promoDiscount: parseNumG(colFirst(v,['promo_discount','coded_discount','promo_discounts'])),
      saltDiscount: parseNumG(colFirst(v,['salt_discount','salt_discounts'])) || parseNumG(col(v,'salt')),
      packagingCharges: parseNumG(col(v,'packaging_charges')),
      // ---- newer columns: rating, OTR and menu-quality scores ----
      rating: parseNumG(col(v,'res_rating') || hygJ.Rating),
      otr: parseNumG(col(v,'otr')),
      mxRejections: parseNumG(colFirst(v,['mx_rejections','rejections','rejection_count']) || jsonValue(hygJ,['mx_rejections','rejections','rejection_count'])),
      kptDelayed: parseNumG(colFirst(v,['kpt_delayed_orders','kpt_delay','kpt_delayed']) || jsonValue(hygJ,['kpt_delayed_orders','kpt_delay','kpt_delayed'])),
      menuItems: parseNumG(col(v,'total_menu_items') || hygJ.total_menu_items),
      noImage: parseNumG(col(v,'items_without_image') || hygJ.items_without_image),
      noDesc: parseNumG(col(v,'items_without_description') || hygJ.items_without_description),
      menuScore: parseNumG(col(v,'final_menu_score') || hygJ.final_menu_score),
      descScore: parseNumG(col(v,'description_score') || hygJ.description_score),
      imageScore: parseNumG(col(v,'image_score') || hygJ.image_score),
      codedOrders: parseNumG(col(v,'coded_orders')),
      mvdOv: parseNumG(col(v,'mvd ov')),
      saltOrders: parseNumG(col(v,'salt orders')),
      autoRenewal: parseNumG(col(v,'auto_renewal_flag') || adsJ.auto_renewal_flag),
      growMaxxModel: String(col(v,'grow_maxx_model') || adsJ.Grow_Maxx_Model || ''),
      growMaxxX: parseNumG(col(v,'grow_maxx_x_percent') || adsJ.Grow_Maxx_X_Percent),
      growMaxxY: parseNumG(col(v,'grow_maxx_y_percent') || adsJ.Grow_Maxx_Y_Percent),
      gmBilling: parseNumG(col(v,'gm_billing') || adsJ.gm_billing),
      bauBilling: parseNumG(col(v,'bau_billing') || adsJ.bau_billing),
      billedAds: parseNumG(col(v,'total_billing') || adsJ.total_billing),
      monthlyBookedAds: parseNumG(colFirst(v,['monthly_booked_ads','booked_ads','monthly_ads_booked']) || jsonValue(adsJ,['monthly_booked_ads','booked_ads'])),
      bauAdsCv: parseNumG(colFirst(v,['bau_ads_cv','bau_ads/cv']) || jsonValue(adsJ,['bau_ads_cv','bau ads/cv'])),
      gmAdsCv: parseNumG(colFirst(v,['gm_ads_cv','gm_ads/cv']) || jsonValue(adsJ,['gm_ads_cv','gm ads/cv'])),
      adsResCoverage: parseNumG(colFirst(v,['ads_res_coverage','ad_res_coverage']) || jsonValue(adsJ,['ads_res_coverage','ad_res_coverage'])),
      adsCvCoverage: parseNumG(colFirst(v,['ads_cv_coverage','ad_cv_coverage']) || jsonValue(adsJ,['ads_cv_coverage','ad_cv_coverage'])),
      effBr: parseNumG(col(v,'eff_br') || adsJ.Eff_BR),
      ineffBr: parseNumG(col(v,'ineff_br') || adsJ.Ineff_BR),
      adsRoi: parseNumG(col(v,'roi') || adsJ.ROI),
      adOrders: parseNumG(col(v,'ad_orders') || adsJ.Ad_Orders),
      adClicks: parseNumG(colFirst(v,['ad_clicks','ads_clicks','clicks']) || jsonValue(adsJ,['ad_clicks','ads_clicks','clicks'])),
      deliveryPct: parseNumG(col(v,'delivery_percent') || adsJ.Delivery_Percent),
      cpc: parseNumG(col(v,'cpc') || adsJ.cpc),
      // Growth-plan RMS / creative flags. Accept both the raw scorecard
      // headers and JSON variants so a column-name cleanup never disables
      // restaurant actionables.
      ovRms: parseNumG(colFirst(v,['ov_rms','ov_rms_percent','res_ov_rms','restaurant_ov_rms','rms']) || jsonValue(shareJ,['ov_rms','ov_rms_percent','res_ov_rms','restaurant_ov_rms','rms'])),
      impressionRms: parseNumG(colFirst(v,['impression_rms','impression_rms_percent','impressions_rms','res_impression_rms','restaurant_impression_rms']) || jsonValue(funnelJ,['impression_rms','impression_rms_percent','impressions_rms','res_impression_rms','restaurant_impression_rms'])),
      thumbnailKnown: String(colFirst(v,['thumbnail_image','thumbnail_image_flag','has_thumbnail_image','has_thumbnail','thumbnail_status']) || jsonValue(hygJ,['thumbnail_image','thumbnail_image_flag','has_thumbnail_image','has_thumbnail','thumbnail_status'])).trim() !== '',
      hasThumbnail: (function(x){ x=String(x||'').trim().toLowerCase(); return (x==='yes'||x==='y'||x==='true'||x==='live') ? 1 : parseNumG(x); })(colFirst(v,['thumbnail_image','thumbnail_image_flag','has_thumbnail_image','has_thumbnail','thumbnail_status']) || jsonValue(hygJ,['thumbnail_image','thumbnail_image_flag','has_thumbnail_image','has_thumbnail','thumbnail_status'])),
      impressions: parseNumG(colFirst(v,['total_impressions','impressions']) || jsonValue(funnelJ,['total_impressions','impressions'])),
      adImpressions: parseNumG(col(v,'ad_impressions') || jsonValue(funnelJ,['ad_impressions']) || jsonValue(adsJ,['ad_impressions'])),
      organicImpressions: parseNumG(col(v,'organic_impressions') || jsonValue(funnelJ,['organic_impressions'])),
      menuOpens: parseNumG(colFirst(v,['menu_opens','mo','menu_open']) || jsonValue(funnelJ,['menu_opens','mo','menu_open'])),
      cartBuilds: parseNumG(col(v,'cart_builds') || funnelJ.Cart_Builds),
      orderMakes: parseNumG(col(v,'order_makes') || funnelJ.Order_Makes),
      pg13: parseNumG(col(v,'pg_1_3') || pgJ['a. PG [1-3]']),
      pg46: parseNumG(col(v,'pg_4_6') || pgJ['b. PG [4-6]']),
      pg710: parseNumG(col(v,'pg_7_10') || pgJ['c. PG [7-10]']),
      newOrders: parseNumG(col(v,'new_orders') || nrlJ['a. New']),
      repeatOrders: parseNumG(col(v,'repeat_orders') || nrlJ['b. Repeat']),
      lapsedOrders: parseNumG(col(v,'lapsed_orders') || nrlJ['c. Lapsed']),
      breakfastOrders: parseNumG(col(v,'breakfast_orders') || mealJ['a. Breakfast']),
      lunchOrders: parseNumG(col(v,'lunch_orders') || mealJ['b. Lunch']),
      eveningOrders: parseNumG(col(v,'evening_orders') || mealJ['c. Evening']),
      dinnerOrders: parseNumG(col(v,'dinner_orders') || mealJ['d. Dinner']),
      lateNightOrders: parseNumG(col(v,'late_night_orders') || mealJ['e. Late Night']),
      mShare: parseNumG(col(v,'m_share') || shareJ.M_Share) * (parseNumG(col(v,'m_share') || shareJ.M_Share) <= 1 ? 100 : 1),
      zShare: parseNumG(col(v,'z_share') || shareJ.Z_Share) * (parseNumG(col(v,'z_share') || shareJ.Z_Share) <= 1 ? 100 : 1)
    };
  }
  return map;
}

// =========================================================
// CSV / TSV PARSER  (auto-detects tab vs comma)
// Produces slim row objects with rawNovTarget / rawCmTarget.
// =========================================================
function parseNumG(val) {
  if (val === null || val === undefined) return 0;
  var s = String(val).trim();
  if (s === "") return 0;
  // Direct parse first - handles plain numbers AND scientific notation (1.2e+06).
  var n = parseFloat(s);
  if (!isNaN(n)) return n;
  // Fallback: strip thousands separators / stray chars, keep digits . - e +
  var cleaned = s.replace(/,/g, '').replace(/[^0-9.\-eE+]/g, '');
  n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function detectDelim(headerLine) {
  var tabs = (headerLine.match(/\t/g) || []).length;
  var commas = (headerLine.match(/,/g) || []).length;
  return tabs >= commas ? '\t' : ',';
}

function splitLine(line, delim) {
  if (delim === '\t') return line.split('\t');
  // CSV parser with escaped-quote support. JSON cells are valid CSV values
  // such as "{""Rating"":4.2}"; preserving the inner quotes is essential
  // before JSON.parse can read the cell downstream.
  var values = [], inQuotes = false, val = "";
  for (var c = 0; c < line.length; c++) {
    var ch = line[c];
    if (ch === '"') {
      if (inQuotes && line[c + 1] === '"') { val += '"'; c++; }
      else inQuotes = !inQuotes;
    }
    else if (ch === ',' && !inQuotes) { values.push(val); val = ""; }
    else val += ch;
  }
  values.push(val);
  return values;
}

function parseData(csvStr) {
  if (!csvStr) return [];
  var lines = csvStr.replace(/\r/g, '').split('\n');
  if (lines.length < 2) return [];

  var delim = detectDelim(lines[0]);
  var headers = splitLine(lines[0], delim).map(function(h){
    return h.replace(/"/g, '').toLowerCase().trim();
  });
  var idx = {};
  for (var h = 0; h < headers.length; h++) idx[headers[h]] = h;
  var col = function(v, name) { var i = idx[name]; return (i === undefined) ? "" : (v[i] || ""); };

  var out = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var v = splitLine(line, delim);
    for (var k = 0; k < v.length; k++) {
      var pv = v[k];
      if (pv && pv.charAt(0) === '"' && pv.charAt(pv.length - 1) === '"') {
        v[k] = pv.substring(1, pv.length - 1).replace(/""/g, '"');
      }
    }
    // NOV files are keyed on res_id and DON'T carry res_name (that comes from
    // AMTL). Super-core NOV files are cluster-level: no res_id/res_name, but
    // they DO carry city_cluster + city_name. Accept a row if it has ANY of
    // res_id / res_name / cluster / city.
    var rid = col(v, 'res_id');
    var rest = col(v, 'res_name');
    var clus = col(v, 'city_cluster_new') || col(v, 'city_cluster');
    var cityNm = col(v, 'city_name') || col(v, 'city');
    var hasId = rid && String(rid).trim() !== '';
    var hasName = rest && rest.trim() !== '';
    var hasClus = clus && String(clus).trim() !== '';
    var hasCity = cityNm && String(cityNm).trim() !== '';
    if (!hasId && !hasName && !hasClus && !hasCity) continue;
    // display fallback: res_name -> res_id -> cluster -> city
    if (!hasName) rest = String(rid || clus || cityNm || '');

    out.push({
      period_label: col(v, 'period_label'),
      city: col(v, 'city_name') || col(v, 'city') || "Unknown",
      account: col(v, 'account_type') || "Unknown",
      cluster: col(v, 'city_cluster_new') || col(v, 'city_cluster') || "",
      tl: (col(v, 'tl_email') || "N/A").toLowerCase(),
      am: (col(v, 'am_email') || "N/A").toLowerCase(),
      cuisine: col(v, 'cuisine') || "N/A",
      resId: (hasId ? rid : ''),
      restaurant: rest,
      rawNovTarget: parseNumG(col(v, 'nov_target')),
      rawCmTarget: parseNumG(col(v, 'supply_cm_target')),
      novActual: parseNumG(col(v, 'nov_actual')),
      cmActual: parseNumG(col(v, 'supply_cm_actual')),
      wallet_share: parseNumG(col(v, 'wallet_share')),
      bill_subtotal: parseNumG(col(v, 'bill_subtotal')),
      packaging_charges: parseNumG(col(v, 'packaging_charges')),
      commission_revenue: parseNumG(col(v, 'commission_revenue')),
      mvd: parseNumG(col(v, 'mvd')),
      salt_discount: parseNumG(col(v, 'salt_discount')),
      zvd: parseNumG(col(v, 'zvd')),
      // columns that may not exist in the new files -> default 0
      ad_rev: parseNumG(col(v, 'ad_rev')),
      total_orders: parseNumG(col(v, 'total_orders')),
      commissionableAmount: parseNumG(col(v, 'commissionable_amount'))
    });
  }
  return out;
}

// KAM-level parser for the full-quarter file. Unlike parseData it does NOT
// require res_name (this file may be aggregated to KAM level). It keeps the
// fields needed for role-scoping (am/tl) and the four target/actual numbers.
function parseFullQuarter_(csvStr) {
  if (!csvStr) return [];
  var lines = csvStr.replace(/\r/g, '').split('\n');
  if (lines.length < 2) return [];
  var delim = detectDelim(lines[0]);
  var headers = splitLine(lines[0], delim).map(function(h){ return h.replace(/"/g,'').toLowerCase().trim(); });
  var idx = {}; for (var h = 0; h < headers.length; h++) idx[headers[h]] = h;
  var col = function(v, name){ var i = idx[name]; return (i === undefined) ? "" : (v[i] || ""); };

  var out = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var v = splitLine(line, delim);
    for (var k = 0; k < v.length; k++) {
      var pv = v[k];
      if (pv && pv.charAt(0) === '"' && pv.charAt(pv.length-1) === '"') v[k] = pv.substring(1, pv.length-1).replace(/""/g,'"');
    }
    var nt = parseNumG(col(v,'nov_target')), na = parseNumG(col(v,'nov_actual'));
    var ct = parseNumG(col(v,'supply_cm_target')), ca = parseNumG(col(v,'supply_cm_actual'));
    // skip completely empty rows
    if (!nt && !na && !ct && !ca && !col(v,'am_email') && !col(v,'tl_email')) continue;
    out.push({
      period_label: col(v,'period_label'),
      city: col(v,'city_name') || "Unknown",
      account: col(v,'account_type') || "Unknown",
      tl: (col(v,'tl_email') || "N/A").toLowerCase(),
      am: (col(v,'am_email') || "N/A").toLowerCase(),
      restaurant: col(v,'res_name') || col(v,'am_email') || 'kam',
      resId: col(v,'res_id') || '',
      rawNovTarget: nt, novActual: na, rawCmTarget: ct, cmActual: ca
    });
  }
  return out;
}

function filterRowsByRole(rows, context) {
  if (context.isAdmin) return rows;          // super / ceo / granted -> whole scope
  if (!context.email) return [];
  var email = context.email;
  var kams = context.kams || [];
  return rows.filter(function(r) {
    if ((r.am && r.am === email) || (r.tl && r.tl === email)) return true;
    // ZH: also see rows owned by their KAMs
    if (context.role === 'zh' && r.am && kams.indexOf(r.am) !== -1) return true;
    return false;
  });
}

// =========================================================
// PERIOD SCOPING
// Files carry the whole quarter; we cut each to what its view means "today".
// New period_label formats:
//   day     -> "01-Jul-2026"    (single day rows)
//   week    -> "2026-W27"       (ISO week buckets)  -> keep current week
//   month   -> "2026-07"        (month buckets)     -> keep current month
//   quarter -> "2026-Q3"        (quarter buckets)   -> keep as-is (file jaisa)
// =========================================================
var MON_ABBR3 = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

// ISO week number of a date (1..53), ISO year too.
function isoWeekParts(d) {
  var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var dayNr = (t.getUTCDay() + 6) % 7;      // Mon=0
  t.setUTCDate(t.getUTCDate() - dayNr + 3); // Thursday of this week
  var firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  var firstDayNr = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNr + 3);
  var week = 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
  return { year: t.getUTCFullYear(), week: week };
}
function isoWeekLabel(d) {
  var p = isoWeekParts(d);
  return p.year + '-W' + (p.week < 10 ? '0' + p.week : p.week);
}
function monthLabel(d) {
  var m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
}

// Parse a day label like "01-Jul-2026" -> Date (used for the day file / WTD calc).
function parsePeriodLabelToDate(label) {
  if (!label) return null;
  var s = String(label).trim();
  var m = s.match(/(\d{1,2})[-\/ ]([A-Za-z]{3,})[-\/ ](\d{2,4})/);
  if (m) {
    var day = parseInt(m[1],10);
    var mon = MON_ABBR3[m[2].toLowerCase().slice(0,3)];
    var yr = parseInt(m[3],10); if (yr < 100) yr += 2000;
    if (mon !== undefined) return new Date(yr, mon, day);
  }
  return null;
}

function scopeRowsForPeriod(rows, period, refDate) {
  if (period === 'quarter') return rows;   // file jaisa hai waisa

  if (period === 'lastweek') {
    // Last Week is derived from the day-wise NOV feed. Use the latest date
    // available in that feed as the reference, then select the preceding
    // completed Monday-Sunday bucket.
    var datesLW = {};
    for (var lw = 0; lw < rows.length; lw++) {
      var ld = parsePeriodLabelToDate(rows[lw].period_label);
      if (ld) datesLW[ld.getTime()] = 1;
    }
    var keysLW = Object.keys(datesLW).map(Number).sort(function(a,b){ return a-b; });
    if (!keysLW.length) return [];
    var currentMon = mondayOf(new Date(keysLW[keysLW.length - 1]));
    var previousMon = new Date(currentMon.getFullYear(), currentMon.getMonth(), currentMon.getDate() - 7);
    return rows.filter(function(r){
      var d = parsePeriodLabelToDate(r.period_label);
      return d && sameYMD(mondayOf(d), previousMon);
    });
  }

  if (period === 'day') {
    // The day file is day-wise (1st -> today). For "Day (T-1)" we want ONLY the
    // single latest date's rows (the most recent day), not the whole month.
    var dates = {};
    for (var i = 0; i < rows.length; i++) {
      var d = parsePeriodLabelToDate(rows[i].period_label);
      if (d) dates[d.getTime()] = 1;
    }
    var keys = Object.keys(dates).map(Number).sort(function(a,b){ return a-b; });
    if (keys.length <= 1) return rows;      // only one date -> use all
    var maxDate = keys[keys.length - 1];    // latest available day
    return rows.filter(function(r){
      var dd = parsePeriodLabelToDate(r.period_label);
      return dd && dd.getTime() === maxDate;   // keep ONLY the latest date
    });
  }

  if (period === 'month') {
    var wantMon = monthLabel(refDate);              // "2026-07"
    var legacyMon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][refDate.getMonth()];
    var legacyYr = refDate.getFullYear();
    var out = rows.filter(function(r){
      var lab = String(r.period_label || '').toLowerCase().trim();
      if (lab === wantMon) return true;
      if (lab === (legacyMon + '-' + legacyYr)) return true;   // "jul-2026"
      if (lab.indexOf(legacyMon) !== -1 && lab.indexOf(String(legacyYr)) !== -1) return true; // "july 2026"
      return false;
    });
    if (out.length) return out;
    // Never return a whole historical monthly CSV merely because its upload
    // date and its period_label use different formats. Pick its newest labelled
    // month instead; otherwise a large cluster can exceed the Apps Script
    // response limit before the dashboard receives its first screen.
    var monthNo = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    var labelMonth = function(label){
      var s = String(label || '').toLowerCase().trim(), m;
      m = s.match(/(20\d{2})[-\/_ ](0?[1-9]|1[0-2])/);
      if (m) return Number(m[1]) * 100 + Number(m[2]);
      m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\/_ ]?(20\d{2})/);
      return m ? Number(m[2]) * 100 + monthNo[m[1]] : 0;
    };
    var newest = 0;
    rows.forEach(function(r){ newest = Math.max(newest, labelMonth(r.period_label)); });
    if (newest) {
      var latestRows = rows.filter(function(r){ return labelMonth(r.period_label) === newest; });
      if (latestRows.length) return latestRows;
    }
    return rows;
  }

  if (period === 'week') {
    var wantWk = isoWeekLabel(refDate).toLowerCase();  // "2026-w27"
    var out = rows.filter(function(r){
      return String(r.period_label || '').toLowerCase().trim() === wantWk;
    });
    if (out.length) return out;
    // legacy fallback: labels are day-dates -> pick current Mon-Sun bucket
    var targetMon = mondayOf(refDate);
    var byDate = rows.filter(function(r){
      var d = parsePeriodLabelToDate(r.period_label);
      return d && sameYMD(mondayOf(d), targetMon);
    });
    // Nov_week is already the week's data — if nothing matched, use it as-is.
    return byDate.length ? byDate : rows;
  }
  return rows;
}

// Monday of the week containing date d (local).
function mondayOf(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}
function sameYMD(a, b) {
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

// =========================================================
// FRONTEND ENDPOINTS - always return a clean object, never throw.
// =========================================================

// Live data for a given period ('day' | 'week' | 'month' | 'quarter').
function getPeriodData(period, viewer, clusterOverride, viewAsKam) {
  // Period loads are intentionally independent: Mumbai (and any large cluster)
  // must never parse every NOV file just to open the default Month view.
  if (arguments.length > 1) {
    setClusterOverride_(clusterOverride || '');
    setViewAsKam_(viewAsKam || '');
    setViewer_(viewer || '');
  }
  const context = getUserContext();
  trackPresence(context.email);
  if (PERIODS.indexOf(period) === -1) period = 'day';
  var health = clusterLoadHealth_(context.email || (__VIEWER_EMAIL || getCurrentEmail_()), __CLUSTER_OVERRIDE || '', period);
  if (!health.ok) return { context:context, period:period, status:'CONFIG_ERROR', message:health.message, rows:[] };

  // Last Week is a computed slice of the Day NOV file, not a separate upload.
  var file = readPeriodFile(period === 'lastweek' ? 'day' : period);
  if (!file) {
    return { context: context, period: period, status: "BUILDING",
             generatedAt: new Date().toISOString(), rows: [] };
  }
  var refDate = new Date(file.fileDate);
  var rows = scopeRowsForPeriod(parseData(file.csv), period, refDate);
  rows = enrichRowsFromAmtl_(rows);
  rows = filterRowsByRole(rows, context);
  return {
    context: context, period: period, status: "OK",
    fileName: file.name, generatedAt: file.fileDate, rows: rows
  };
}

// ONE-SHOT loader: parse all four live period files, scope + role-filter each,
// and return them together so the dashboard loads everything once and never
// re-fetches on period toggle. Files are small so this is fine in one call.
// ---- Smart cache: keep parsed data until the source files actually change ----
// We build a lightweight "signature" from every CSV's last-updated time in the
// folder. If nothing changed, we serve the cached parse (fast). The moment any
// file is re-uploaded (even same name), its updated-time changes -> signature
// changes -> we re-parse automatically. So data is always latest, but fast.
var __FOLDER_SIG = null;
var FOLDER_SIGNATURE_TTL_SEC = 300; // Avoid scanning every Drive CSV on every request.
function folderSignatureCacheKey_() {
  try {
    var folder = getCacheFolder();
    return 'folder_sig_v4_' + (folder ? folder.getId() : 'none');
  } catch (e) {
    return 'folder_sig_v4_default';
  }
}
function clearFolderSignatureCache_() {
  __FOLDER_SIG = null;
  try { CacheService.getScriptCache().remove(folderSignatureCacheKey_()); } catch (e) {}
}
function folderSignature_(forceRefresh) {
  if (__FOLDER_SIG && !forceRefresh) return __FOLDER_SIG;
  var cache = null, key = folderSignatureCacheKey_();
  try {
    cache = CacheService.getScriptCache();
    if (!forceRefresh) {
      var cached = cache.get(key);
      if (cached) { __FOLDER_SIG = cached; return cached; }
    }
  } catch (e) {}
  try {
    var idx = folderIndex_();
    var parts = [];
    for (var nm in idx) {
      if (nm.indexOf('.csv') === -1) continue;
      parts.push(nm + ':' + idx[nm].getLastUpdated().getTime());
    }
    parts.sort();
    __FOLDER_SIG = parts.join('|');
    if (cache) cache.put(key, __FOLDER_SIG, FOLDER_SIGNATURE_TTL_SEC);
    return __FOLDER_SIG;
  } catch (e2) {
    return 'nosig-' + Date.now();   // if we can't read, force a fresh parse
  }
}

// Retrieve a cached value only if the folder signature still matches.
function cacheGetIfFresh_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var sig = cache.get(key + '__sig');
    if (!sig) return null;
    if (sig !== folderSignature_()) return null;   // files changed -> stale
    var chunks = Number(cache.get(key + '__n') || 0);
    if (!chunks) { var raw = cache.get(key); return raw ? JSON.parse(raw) : null; }
    var buf = '';
    for (var i = 0; i < chunks; i++) { var c = cache.get(key + '__' + i); if (c === null) return null; buf += c; }
    return JSON.parse(buf);
  } catch (e) { return null; }
}

// Store a value plus the current signature. Large payloads are split into
// 90 KB chunks (CacheService caps each value at 100 KB).
function cachePut_(key, obj) {
  try {
    var cache = CacheService.getScriptCache();
    var str = JSON.stringify(obj);
    var sig = folderSignature_();
    var TTL = 21600;   // 6h ceiling; signature makes it refresh sooner if files change
    if (str.length < 90000) {
      cache.put(key, str, TTL);
      cache.put(key + '__n', '0', TTL);
    } else {
      var size = 90000, n = Math.ceil(str.length / size);
      var kv = {};
      for (var i = 0; i < n; i++) kv[key + '__' + i] = str.substr(i * size, size);
      cache.putAll(kv, TTL);
      cache.put(key + '__n', String(n), TTL);
    }
    cache.put(key + '__sig', sig, TTL);
  } catch (e) { /* cache is best-effort; ignore */ }
}

// ---- Pre-baked payload on Drive ----
// CacheService silently drops payloads over its ~100 KB/value limit, so large
// clusters were re-parsing every CSV on every load (~1 min). We bake the parsed
// unscoped payload into a single JSON file in the data folder; loads read that
// file (one Drive fetch + JSON.parse) instead of re-reading every CSV.
var BAKE_FILE_NAME = '_baked_allperiods_v1.json';

function readBaked_() {
  try {
    var folder = getCacheFolder();
    var it = folder.getFilesByName(BAKE_FILE_NAME);
    if (!it.hasNext()) return null;
    var obj = JSON.parse(it.next().getBlob().getDataAsString());
    if (!obj || !obj.__sig || !obj.payload) return null;
    if (obj.__sig !== folderSignature_()) return null;   // data changed -> stale
    // Guard against an empty bake (e.g. baked before data existed): if no period
    // has any rows, treat it as stale so we recompute from the CSVs.
    var p = obj.payload.periods || {};
    var anyRows = ['day','week','month','quarter'].some(function(k){ return p[k] && p[k].length; });
    if (!anyRows) return null;
    return obj.payload;
  } catch (e) { return null; }
}

function writeBaked_(payload) {
  try {
    var folder = getCacheFolder();
    var body = JSON.stringify({ __sig: folderSignature_(), bakedAt: new Date().toISOString(), payload: payload });
    var it = folder.getFilesByName(BAKE_FILE_NAME);
    while (it.hasNext()) it.next().setTrashed(true);   // overwrite = trash old + create new
    folder.createFile(BAKE_FILE_NAME, body, 'application/json');
  } catch (e) { /* best-effort */ }
}

// Recompute + bake the payload. Safe to call from a time-driven trigger set to
// run shortly after Ether's daily drop, so even the first load is fast.
function refreshBake() {
  clearFolderSignatureCache_();   // recompute the signature against current files
  var base = computeAllPeriods_({ isAdmin: true, email: '' });
  writeBaked_(base);
  try { cachePut_('allPeriods_v3_unscoped', base); } catch (e) {}
  return 'baked ' + new Date().toISOString();
}

function getAllPeriods(viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var context;
  try { context = getUserContext(); } catch (e) { context = { email:'', isAdmin:false }; }
  try { trackPresence(context.email); } catch (e) {}
  var health = clusterLoadHealth_(context.email || (__VIEWER_EMAIL || getCurrentEmail_()), clusterOverride || '');
  if (!health.ok) return { status:'CONFIG_ERROR', message:health.message, context:context, periods:null };

  // Heavy part (file reads + parsing) is cached UNSCOPED (admin-wide) and reused
  // until files change. Every request then scopes it to the caller's role, so a
  // KAM/TL only ever sees their own restaurants — even on a cache hit.
  var folderSig = '';
  try { folderSig = String(resolveViewer_(context.email || (__VIEWER_EMAIL||getCurrentEmail_()), __CLUSTER_OVERRIDE).folderId || ''); } catch(e){}
  var CACHE_KEY = 'allPeriods_v3_unscoped_' + folderSig;
  var adminCtx = { isAdmin: true, email: context.email };   // force unscoped compute
  var cached = null;
  try { cached = cacheGetIfFresh_(CACHE_KEY); } catch (e) { cached = null; }

  var base;
  if (cached && cached.periods) {
    base = cached;                                 // L1: CacheService (fast when it fits)
  } else {
    base = readBaked_();                           // L2: pre-baked Drive file (reliable)
    if (base && base.periods) {
      try { cachePut_(CACHE_KEY, base); } catch (e) {}
    } else {
      cached = null;
      base = computeAllPeriods_(adminCtx);         // L3: full parse (slow) + bake for next time
      try { cachePut_(CACHE_KEY, base); } catch (e) {}
      try { writeBaked_(base); } catch (e) {}
    }
  }

  // Build the caller-scoped view from the unscoped base.
  var result;
  try {
    result = scopeResultForCaller_(base, context);
  } catch (e) {
    result = base;                                  // fall back to the raw payload
  }
  result.context = context;
  result.cached = !!cached;
  try { result.fullQuarter = computeFullQuarter_(context); } catch (e) { result.fullQuarter = null; }
  try { result.todayTarget = computeTodayTarget_(context); } catch (e) { result.todayTarget = { novTarget:0, cmTarget:0 }; }
  try {
    result.metrics = {
      day: parseMetricsCached_('day') || {},
      week: parseMetricsCached_('week') || {},
      month: parseMetricsCached_('month') || {}
    };
  } catch (e2) { result.metrics = { day:{}, week:{}, month:{} }; }

  return result;
}

  // Deep-dive metrics maps (res_id -> metrics) for day/week/month.
  // getAllPeriods includes the same maps during bootstrap; this helper keeps the
  // existing background refresh hook compatible.
function getMetricsData(viewer, clusterOverride, viewAsKam, requestedPeriod) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var out = { day:{}, week:{}, month:{} };
  try {
    var p = String(requestedPeriod || '').toLowerCase();
    var needed = (p === 'day' || p === 'week' || p === 'month') ? [p] : ['day','week','month'];
    needed.forEach(function(k){ out[k] = parseMetricsCached_(k) || {}; });
  } catch (e) {}
  return { status:'OK', metrics: out };
}

// Today's Target (T-0), scoped to the caller. Computed per request (not cached)
// so a KAM/TL sees only their own portfolio's target, not the whole cluster's.
function computeTodayTarget_(context) {
  try {
    var dfile = readPeriodFile('day');
    if (!dfile) return { novTarget: 0, cmTarget: 0 };
    var allDay = filterRowsByRole(parseData(dfile.csv), context);
    var dts = {};
    allDay.forEach(function(r){ var d = parsePeriodLabelToDate(r.period_label); if (d) dts[d.getTime()] = 1; });
    var dk = Object.keys(dts).map(Number).sort(function(a,b){ return a-b; });
    var novT = 0, cmT = 0;
    if (dk.length) {
      var t0 = dk[dk.length - 1];   // latest date present = today (T-0)
      allDay.forEach(function(r){
        var d = parsePeriodLabelToDate(r.period_label);
        if (d && d.getTime() === t0) { novT += r.rawNovTarget || 0; cmT += r.rawCmTarget || 0; }
      });
    }
    return { novTarget: novT, cmTarget: cmT };
  } catch (e) { return { novTarget: 0, cmTarget: 0 }; }
}

// Take the unscoped base payload and return a copy scoped to the caller.
// Admins get everything; a KAM/TL gets only rows for their own am/tl.
function scopeResultForCaller_(base, context) {
  // shallow clone so we don't mutate the cached object
  var out = {};
  for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];

  if (context.isAdmin) {
    out.tickerMisses = base.tickerMissesAll || base.tickerMisses || [];
    return out;
  }

  var me = String(context.email || '').toLowerCase();
  var mine = function(r){ return (r.am && String(r.am).toLowerCase() === me) || (r.tl && String(r.tl).toLowerCase() === me); };

  // scope each period's rows
  var scopedPeriods = {};
  ['day','week','month','quarter'].forEach(function(p){
    var rows = base.periods ? base.periods[p] : null;
    scopedPeriods[p] = rows ? rows.filter(mine) : rows;
  });
  out.periods = scopedPeriods;

  // scope the ticker misses
  out.tickerMisses = scopeMisses_(base.tickerMissesAll || base.tickerMisses || [], context);

  // leaderboard stays cluster-wide (everyone sees the same race);
  // the "you're on rank X" banner is computed on the client from context.email.
  return out;
}

// Full-quarter Target vs Achievement (whole quarter, role-scoped) from the
// Nov_quarter cluster file (period_label,res_id,am_email,cuisine,tl_email,
// nov_target,nov_actual,supply_cm_target,supply_cm_actual).
function computeFullQuarter_(context) {
  try {
    var fqFile = readPeriodFile('quarter');
    if (!fqFile) return null;
    var rows = csvToObjects_(fqFile.csv);
    var me = String((context && context.email) || '').toLowerCase();
    var isAdmin = context && (context.isAdmin || context.role === 'ceo' || context.role === 'super');
    var novT = 0, novA = 0, cmT = 0, cmA = 0;
    rows.forEach(function(r){
      var am = String(r.am_email||'').toLowerCase(), tl = String(r.tl_email||'').toLowerCase();
      if (!isAdmin && am !== me && tl !== me) return;
      novT += num_(r.nov_target);  novA += num_(r.nov_actual);
      cmT  += num_(r.supply_cm_target); cmA += num_(r.supply_cm_actual);
    });
    return { novTarget: novT, novActual: novA, cmTarget: cmT, cmActual: cmA };
  } catch (e) { return null; }
}

// Admin-only: top deficit for "Other" account types (CKA / NKA) for a period.
// period in {week, month, quarter}. Returns top 25 by combined NOV+CM deficit.
// =========================================================
// LEAD LIST  — build a working Google Sheet of actionables
// =========================================================
// Lead lists are saved into a fixed Drive folder (ROM / BHMH each have one).
const LEADLIST_FOLDER_ID = '1jLbHMxaII902tbhDZsS0GKFJdYwrukT6';   // lead lists (per-cluster subfolders)
// Audit log of who generated which lead list (one sheet per month).
const LEADLIST_LOG_FOLDER_ID = '1IRoGLLPKSDjY5Aikh8Ga0fauJq9INmv7';

function getLeadListFolder_() {
  try { return DriveApp.getFolderById(LEADLIST_FOLDER_ID); }
  catch (e) { return DriveApp.getRootFolder(); }
}

// Peer benchmark map: cuisine x city -> { mvdAvg, mvdMax, adsAvg, adsMax }
function buildPeerBench_(metricMap, info) {
  info = info || {};
  var groups = {};
  for (var k in metricMap) {
    var m = metricMap[k];
    var fb = info[k] || {};
    var cui = String(m.cuisine || fb.cuisine || '').toLowerCase().trim();
    var city = String(m.city || fb.city || '').toLowerCase().trim();
    if (!city) continue;
    var key = cui + '||' + city;
    var sv = m.sv||0, cv = m.cv||0;
    var mv = sv>0 ? (m.mvdAmt/sv*100) : parseFloat(m.actual_mvd_sv||0);
    var ad = cv>0 ? (m.ad_rev/cv*100) : 0;
    if (!groups[key]) groups[key] = { mvd:[], ads:[] };
    if (isFinite(mv) && mv>0) groups[key].mvd.push(mv);
    if (isFinite(ad) && ad>0) groups[key].ads.push(ad);
  }
  var out = {};
  for (var g in groups) {
    var a = groups[g].mvd, b = groups[g].ads;
    var st = function(arr){
      if (!arr.length) return { avg:0, max:0, n:0 };
      var s=0, mx=0;
      for (var i=0;i<arr.length;i++){ s+=arr[i]; if(arr[i]>mx) mx=arr[i]; }
      return { avg:s/arr.length, max:mx, n:arr.length };
    };
    out[g] = { mvd: st(a), ads: st(b) };
  }
  return out;
}

// Build the lead rows for the caller (role-scoped) for a given period.
function buildLeadRows_(period, context, opts) {
  opts = opts || {};
  var kamFilter = String(opts.kam || '').toLowerCase().trim();      // '' = no filter
  var cityAccountsOnly = !!opts.cityAccountsOnly;
  var map = parseMetricsCached_(period);
  if (!Object.keys(map).length) return { rows: [], period: period };

  // last-period metrics (rom_last_<period>_D_M.csv) for the "last month" columns
  var lastMap = {};
  try {
    var lf = readLastMetricFile_(period);
    if (lf) lastMap = parseMetrics(lf.csv);
  } catch (e) { /* comparison is optional */ }

  // Fallback details (cuisine / KAM / TL / name / city) from the period file,
  // because the metrics CSV may not carry those columns.
  var info = {};
  try {
    var pf = readPeriodFile(period);
    if (pf) {
      parseData(pf.csv).forEach(function(r){
        var rid = String(r.resId||'').trim();
        if (!rid || info[rid]) return;
        info[rid] = { res: r.restaurant||'', city: r.city||'', cuisine: r.cuisine||'',
                      account: String(r.account||''),
                      novTarget: r.rawNovTarget||0, novActual: r.novActual||0,
                      am: String(r.am||'').toLowerCase(), tl: String(r.tl||'').toLowerCase() };
      });
    }
  } catch (e) { /* fallback is best-effort */ }

  var bench = buildPeerBench_(map, info);

  // City-wide fallback: when a cuisine x city group has fewer than 2 outlets,
  // benchmark against every outlet in that city instead.
  var cityBench = {};
  (function(){
    var g = {};
    for (var id2 in map) {
      var mm = map[id2], fb2 = info[id2] || {};
      var ct = String(mm.city || fb2.city || '').toLowerCase().trim();
      if (!ct) continue;
      var sv2 = mm.sv||0, cv2 = mm.cv||0;
      var mv2 = sv2>0 ? (mm.mvdAmt/sv2*100) : parseFloat(mm.actual_mvd_sv||0);
      var ad2 = cv2>0 ? (mm.ad_rev/cv2*100) : 0;
      if (!g[ct]) g[ct] = { mvd:[], ads:[] };
      if (isFinite(mv2) && mv2>0) g[ct].mvd.push(mv2);
      if (isFinite(ad2) && ad2>0) g[ct].ads.push(ad2);
    }
    var st2 = function(a){
      if (!a.length) return { avg:0, max:0, n:0 };
      var s=0,mx=0; for (var i=0;i<a.length;i++){ s+=a[i]; if(a[i]>mx) mx=a[i]; }
      return { avg:s/a.length, max:mx, n:a.length };
    };
    for (var c2 in g) cityBench[c2] = { mvd: st2(g[c2].mvd), ads: st2(g[c2].ads) };
  })();

  // role scope: restrict to the caller's own restaurants
  var me = String(context.email||'').toLowerCase();
  var rows = [];

  for (var id in map) {
    var m = map[id];
    var fb = info[id] || {};
    // prefer the metrics file, fall back to the period file
    var amE = String(m.am || fb.am || '').toLowerCase();
    var tlE = String(m.tl || fb.tl || '').toLowerCase();
    var cuis = m.cuisine || fb.cuisine || '';
    var cityN = m.city || fb.city || '';
    var resN = m.nmDisp || m.nm || fb.res || '';
    if (!context.isAdmin) {
      if (amE !== me && tlE !== me) continue;
    }
    // optional filters: a specific KAM, and/or City Accounts only
    if (kamFilter && amE !== kamFilter && tlE !== kamFilter) continue;
    if (cityAccountsOnly) {
      var acct = String(fb.account || '').toLowerCase();
      if (acct.indexOf('city account') === -1) continue;
    }
    var sv = m.sv||0, cv = m.cv||0, orders = m.total_orders||0;
    var mvdSv = sv>0 ? (m.mvdAmt/sv*100) : parseFloat(m.actual_mvd_sv||0);
    var adsCv = cv>0 ? (m.ad_rev/cv*100) : 0;
    var intMvd = parseFloat(m.intended_mvd_sv||0);
    var items = m.menuItems||0;
    var imgCov = items>0 ? ((items - (m.noImage||0))/items*100) : (m.imageScore||0);
    var descCov = items>0 ? ((items - (m.noDesc||0))/items*100) : (m.descScore||0);
    var vis = (m.expected||0)>0 ? ((m.actual||0)/(m.expected||1)*100) : 0;

    // last-period values for the same outlet
    var lm = lastMap[id];
    var lastMvdSv = 0, lastAdsCv = 0;
    if (lm) {
      var lsv = lm.sv||0, lcv = lm.cv||0;
      lastMvdSv = lsv>0 ? (lm.mvdAmt/lsv*100) : parseFloat(lm.actual_mvd_sv||0);
      lastAdsCv = lcv>0 ? (lm.ad_rev/lcv*100) : 0;
    }

    var key = String(cuis||'').toLowerCase().trim() + '||' + String(cityN||'').toLowerCase().trim();
    var pb = bench[key] || { mvd:{avg:0,max:0,n:0}, ads:{avg:0,max:0,n:0} };
    // MVD/SV must stay strictly cuisine × city. Keep this peer set before the
    // Ads/CV city fallback below, which is not valid for MVD comparisons.
    var mvdPeer = pb.mvd;
    // fall back to the city-wide group if this cuisine has too few outlets
    var cb = cityBench[String(cityN||'').toLowerCase().trim()] || { mvd:{avg:0,max:0,n:0}, ads:{avg:0,max:0,n:0} };
    var benchLabel = (mvdPeer.n >= 2) ? (cuis + ' in ' + cityN) : (cityN + ' (all cuisines)');
    if (pb.mvd.n < 2 && cb.mvd.n >= 2) pb = { mvd: cb.mvd, ads: pb.ads };
    if (pb.ads.n < 2 && cb.ads.n >= 2) pb = { mvd: pb.mvd, ads: cb.ads };

    // ---- growth trend vs last period: shapes how aggressive the target is ----
    var lastOrders = lm ? (lm.total_orders||0) : 0;
    var growthPct = (lastOrders > 0) ? ((orders - lastOrders) / lastOrders * 100) : 0;
    // already growing well -> gentler ask (2pp). Flat/declining -> firmer ask (3pp).
    var askCap = (growthPct >= 10) ? 2 : (growthPct >= 0 ? 2.5 : 3);

    // ---- MVD/SV target: peer AVG is the target, peer MAX is the ceiling ----
    // Peers must be a real group (3+ outlets). Being a whisker under the average
    // is normal — half of any group sits below it — so we only flag outlets that
    // are meaningfully behind (at least 20% short of the peer average).
    var hasMvdPeers = (mvdPeer.n >= 2);
    var hasAdsPeers = (pb.ads.n >= 3);
    var MEANINGFUL = 0.80;                          // must be under 80% of peer avg
    var mvdTarget = 0, mvdUplift = 0;
    if (hasMvdPeers && mvdPeer.avg > 0 && mvdSv < mvdPeer.avg) {
      // Same cuisine × city is below average: take only the next practical
      // 2–3pp step. Peer max is a ceiling/reference, never an uplift target.
      var mvdGap = mvdPeer.avg - mvdSv;
      mvdUplift = mvdGap >= 3 ? 3 : (mvdGap >= 2 ? 2.5 : mvdGap);
      mvdTarget = Math.min(mvdPeer.max || Infinity, mvdPeer.avg, mvdSv + mvdUplift);
      mvdUplift = mvdTarget - mvdSv;
      if (mvdUplift <= 0) { mvdUplift = 0; mvdTarget = 0; }
    }
    // Ads/CV target: peer average, same growth-aware cap
    var adsTarget = 0, adsUplift = 0;
    if (hasAdsPeers && pb.ads.avg > 0 && adsCv < pb.ads.avg * MEANINGFUL) {
      adsUplift = pb.ads.avg - adsCv;
      if (adsUplift < 2) adsUplift = 2;
      if (adsUplift > askCap) adsUplift = askCap;
      adsTarget = adsCv + adsUplift;
      if (pb.ads.max > 0 && adsTarget > pb.ads.max) { adsTarget = pb.ads.max; adsUplift = adsTarget - adsCv; }
      if (adsUplift <= 0) { adsUplift = 0; adsTarget = 0; }
    }

    // ---- NOV position: only flag restaurants that are actually behind ----
    var novT = fb.novTarget || 0, novA = fb.novActual || 0;
    var novBehind = (novT > 0) ? (novA < novT) : true;   // no target known -> keep it
    if (!novBehind) continue;

    // ---- collect actionables ----
    var actions = [];
    if (mvdUplift > 0) actions.push('MVD/SV ' + mvdSv.toFixed(2) + '% \u2192 ' + mvdTarget.toFixed(2) + '% (+' + mvdUplift.toFixed(2) + 'pp)');
    if (adsUplift > 0) actions.push('Ads/CV ' + adsCv.toFixed(2) + '% \u2192 ' + adsTarget.toFixed(2) + '% (+' + adsUplift.toFixed(2) + 'pp)');

    // ARPO must cover the discount burn per order, otherwise ads are net negative
    var zvdPerOrder = orders > 0 ? ((m.zvdAmt || 0) / orders) : 0;
    var arpo = orders > 0 ? ((m.ad_rev || 0) / orders) : 0;
    var subsidyTrap = (orders > 0 && zvdPerOrder > 0 && arpo < zvdPerOrder);
    if (subsidyTrap) {
      actions.push('ARPO \u20B9' + arpo.toFixed(0) + ' < ZVD/order \u20B9' + zvdPerOrder.toFixed(0) + ' (subsidy trap)');
    }

    if (descCov < 80) actions.push('Descriptions ' + descCov.toFixed(0) + '% (target 80%)');
    if (imgCov < 60) actions.push('Images ' + imgCov.toFixed(0) + '% (target 60%)');

    // weak menu-to-cart -> combos lift perceived value
    var m2cVal = parseFloat(m.m2c || 0) || 0;
    var comboNeeded = (m2cVal > 0 && m2cVal < 30);
    if (comboNeeded) actions.push('M2C ' + m2cVal.toFixed(1) + '% \u2014 add 2-3 combo meals');

    // Engines: only flag when the file explicitly says 0. A blank or missing
    // value means "not reported", not "switched off" — counting those made
    // almost every restaurant look broken.
    var engineState = function(raw){
      if (raw === null || raw === undefined) return null;
      var s = String(raw).trim().toLowerCase();
      if (s === '') return null;                       // unknown
      if (s === '1' || s === '1.0' || s === 'true' || s === 'yes' || s === 'live' || s === 'y') return true;
      if (s === '0' || s === '0.0' || s === 'false' || s === 'no' || s === 'n') return false;
      var n = parseFloat(s);
      if (isNaN(n)) return null;
      return n >= 1;
    };
    var peOn   = engineState(m.peRaw   !== undefined ? m.peRaw   : m.pe);
    var saltOn = engineState(m.saltRaw !== undefined ? m.saltRaw : m.salt);
    var mvdOn  = engineState(m.mvdSRaw !== undefined ? m.mvdSRaw : m.mvdS);

    var enginesOff = false;
    var off = [];
    if (peOn   === false) off.push('PE');
    if (saltOn === false) off.push('Salt');
    if (mvdOn  === false) off.push('MVD');
    if (off.length) {
      enginesOff = true;
      actions.push(off.join('/') + ' not live');
    }
    if (vis > 0 && vis < 95) actions.push('Visibility ' + vis.toFixed(1) + '%');
    if (!actions.length) continue;   // nothing to do here

    rows.push({
      resId: id, res: resN, city: cityN, cuisine: cuis,
      am: amE.split('@')[0], tl: tlE.split('@')[0],
      orders: orders, mvdSv: mvdSv, mvdTarget: mvdTarget, mvdUplift: mvdUplift,
      lastMvdSv: lastMvdSv, lastAdsCv: lastAdsCv,
      peerMvdAvg: mvdPeer.avg, peerMvdMax: mvdPeer.max,
      adsCv: adsCv, adsTarget: adsTarget, adsUplift: adsUplift,
      peerAdsAvg: pb.ads.avg,
      descCov: descCov, imgCov: imgCov, vis: vis,
      menuScore: m.menuScore || 0,
      menuItems: items, noImage: (m.noImage||0), noDesc: (m.noDesc||0),
      benchLabel: benchLabel, enginesOff: enginesOff,
      arpo: arpo, zvdPerOrder: zvdPerOrder, subsidyTrap: subsidyTrap,
      m2c: m2cVal, comboNeeded: comboNeeded,
      lastOrders: lastOrders, growthPct: growthPct,
      actions: actions.join(' | ')
    });
  }

  // priority by order volume: P0 = biggest, then P1, P2
  rows.sort(function(a,b){ return b.orders - a.orders; });
  var n = rows.length;
  rows.forEach(function(r, i){
    r.priority = (i < n*0.2) ? 'P0' : (i < n*0.5 ? 'P1' : 'P2');
  });
  return { rows: rows, period: period };
}

// Endpoint: create a fresh working Google Sheet of leads and return its URL.
function generateLeadList(period, opts) {
  setViewer_(opts && opts.viewer);
  var context = getUserContext();
  var leadRv = resolveViewer_(context.email || (opts && opts.viewer) || getCurrentEmail_(), __CLUSTER_OVERRIDE || '');
  if (['day','week','month'].indexOf(period) === -1) period = 'month';
  opts = opts || {};

  // scope: 'mine' (default), 'kam' (a chosen KAM, admin only), 'cluster' (admin only)
  var scope = String(opts.scope || 'mine');
  if (!context.isAdmin) scope = 'mine';
  var buildOpts = {};
  var scopeLabel = '';
  if (scope === 'kam' && opts.kam) {
    buildOpts.kam = String(opts.kam).toLowerCase().trim();
    scopeLabel = String(opts.kam).split('@')[0];
  } else if (scope === 'cluster') {
    buildOpts.cityAccountsOnly = true;               // cluster list = City Accounts only
    scopeLabel = 'Whole Cluster';
  } else {
    scopeLabel = (context.email||'').split('@')[0];  // own portfolio
  }

  // ---- download cooldown: T-1 once/day, WTD once/week, MTD once/15 days ----
  // Keyed by user+period+scope so an admin can still run each KAM / the cluster
  // once per window. Blocked callers are pointed to their previous sheet.
  var cool = leadCooldownCheck_(context.email, period, scope, opts.kam);
  if (cool.blocked) {
    return { status:'COOLDOWN', message: cool.message, period: period,
             prevUrl: (cool.prev && cool.prev.url) || '',
             prevName: (cool.prev && cool.prev.name) || '' };
  }

  var built = buildLeadRows_(period, context, buildOpts);
  if (!built.rows.length) return { status:'EMPTY', message:'No actionable restaurants found for this selection.' };

  var who = (context.email||'user').split('@')[0];
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MMM-yyyy HH:mm');
  var name = 'Lead List \u2014 ' + scopeLabel + ' \u2014 ' + period.toUpperCase() + ' \u2014 ' + stamp;

  var ss = SpreadsheetApp.create(name);
  var file = DriveApp.getFileById(ss.getId());
  var folderNote = '';
  try {
    var folder = DriveApp.getFolderById(LEADLIST_FOLDER_ID);
    var moved = false;
    // moveTo needs the full Drive scope; fall back to addFile/removeFile which
    // works with the narrower drive.file scope.
    try {
      if (file.moveTo) { file.moveTo(folder); moved = true; }
    } catch (eMove) { moved = false; }
    if (!moved) {
      folder.addFile(file);
      try { DriveApp.getRootFolder().removeFile(file); } catch (e2) {}
    }
  } catch (e) {
    folderNote = 'Saved to My Drive (folder not reachable: ' + (e && e.message ? e.message : e) + ')';
  }
  try {
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (e) { /* sharing is best-effort */ }

  // ---------- Sheet 1: SUMMARY (filled at the end, once tabs exist) ----------
  var sh = ss.getActiveSheet();
  sh.setName('Summary');
  var tabMeta = {};   // tab name -> { rows, approachedCol, convertedCol, uploadedCol }

  // ---------- Sheet 2: MVD/SV lead list ----------
  var mvdRows = built.rows.filter(function(r){ return r.mvdUplift > 0; });
  if (mvdRows.length) {
    var sh2 = ss.insertSheet('MVD-SV');
    var head2 = ['Priority','Res ID','Restaurant','City','Cuisine','KAM','TL','Orders',
                 'LM MVD/SV %','M MVD/SV %','Benchmark group','Benchmark Avg %','Benchmark Max (ceiling) %',
                 'Target MVD/SV %','Increase needed (pp)',
                 'Input (what you did)','Approached','Converted'];
    var data2 = mvdRows.map(function(r){
      return [r.priority, r.resId, r.res, r.city, r.cuisine, r.am, r.tl, Math.round(r.orders),
              +r.lastMvdSv.toFixed(2), +r.mvdSv.toFixed(2), r.benchLabel, +r.peerMvdAvg.toFixed(2), +r.peerMvdMax.toFixed(2),
              +r.mvdTarget.toFixed(2), +r.mvdUplift.toFixed(2), '', '', ''];
    });
    writeLeadSheet_(sh2, head2, data2, [17,18]);
    tabMeta['MVD-SV'] = { rows: data2.length, cols: [17,18] };
  }

  // ---------- Sheet 3: Ads/CV lead list ----------
  var adRows = built.rows.filter(function(r){ return r.adsUplift > 0; });
  if (adRows.length) {
    var sh3 = ss.insertSheet('Ads-CV');
    var head3 = ['Priority','Res ID','Restaurant','City','Cuisine','KAM','TL','Orders',
                 'LM Ads/CV %','M Ads/CV %','Benchmark group','Benchmark Avg (target) %','Target Ads/CV %','Increase needed (pp)',
                 'Input (what you did)','Approached','Converted'];
    var data3 = adRows.map(function(r){
      return [r.priority, r.resId, r.res, r.city, r.cuisine, r.am, r.tl, Math.round(r.orders),
              +r.lastAdsCv.toFixed(2), +r.adsCv.toFixed(2), r.benchLabel, +r.peerAdsAvg.toFixed(2),
              +r.adsTarget.toFixed(2), +r.adsUplift.toFixed(2), '', '', ''];
    });
    writeLeadSheet_(sh3, head3, data3, [16,17]);
    tabMeta['Ads-CV'] = { rows: data3.length, cols: [16,17] };
  }

  // ---------- Sheet 4: Menu Score (details + what did you do) ----------
  var menuRows = built.rows.filter(function(r){ return r.descCov < 80 || r.imgCov < 60; });
  if (menuRows.length) {
    var sh4 = ss.insertSheet('Menu Score');
    var head4 = ['Priority','Res ID','Restaurant','City','Cuisine','KAM','TL',
                 'Menu Score','Total Items','Items without Image','Items without Description',
                 'Image Coverage %','Target 60%','Description Coverage %','Target 80%',
                 'What did you do to improve the menu score?','Approached','Converted'];
    var data4 = menuRows.map(function(r){
      return [r.priority, r.resId, r.res, r.city, r.cuisine, r.am, r.tl,
              +(r.menuScore||0).toFixed(1), Math.round(r.menuItems||0),
              Math.round(r.noImage||0), Math.round(r.noDesc||0),
              +r.imgCov.toFixed(0), 60, +r.descCov.toFixed(0), 80, '', '', ''];
    });
    writeLeadSheet_(sh4, head4, data4, [17,18]);
    tabMeta['Menu Score'] = { rows: data4.length, cols: [17,18] };
  }

  // ---------- Fill the Summary now that the tabs (and their columns) exist ----------
  var cnt = function(f){ var c=0; built.rows.forEach(function(r){ if(f(r)) c++; }); return c; };
  var p0 = cnt(function(r){ return r.priority==='P0'; });
  var p1 = cnt(function(r){ return r.priority==='P1'; });
  var p2 = cnt(function(r){ return r.priority==='P2'; });

  var colLetter = function(n){            // 1 -> A, 27 -> AA
    var s2 = '';
    while (n > 0) { var m2 = (n - 1) % 26; s2 = String.fromCharCode(65 + m2) + s2; n = (n - m2 - 1) / 26; }
    return s2;
  };
  // count of a given answer in a tab column; blank-safe, returns 0 if tab missing
  var ansCount = function(tab, colIdx, answer){
    if (!tabMeta[tab]) return 0;
    var L = colLetter(colIdx);
    var rng = "'" + tab + "'!" + L + '2:' + L;
    return '=IFERROR(COUNTIF(' + rng + ',"' + answer + '"),0)';
  };

  var summary = [
    ['BRAHMASTRA \u2014 LEAD LIST SUMMARY', ''],
    ['Owner', context.email || ''],
    ['Scope', scopeLabel],
    ['Period', period.toUpperCase()],
    ['Generated', stamp],
    ['', ''],
    ['COVERAGE', ''],
    ['Total restaurants with actions', built.rows.length],
    ['P0 (high priority)', p0],
    ['P1 (medium priority)', p1],
    ['P2 (low priority)', p2],
    ['', '']
  ];

  // per-tab progress: total / approached Yes / No / converted Yes / No / uploaded Yes / No
  ['MVD-SV','Ads-CV','Menu Score'].forEach(function(tab){
    var meta = tabMeta[tab];
    summary.push([tab.toUpperCase() + ' PROGRESS', '']);
    if (!meta) { summary.push(['Restaurants in this tab', 0]); summary.push(['', '']); return; }
    var c = meta.cols;
    summary.push(['Restaurants in this tab', meta.rows]);
    summary.push(['Approached \u2014 Yes', ansCount(tab, c[0], 'Yes')]);
    summary.push(['Approached \u2014 No',  ansCount(tab, c[0], 'No')]);
    summary.push(['Converted \u2014 Yes',  ansCount(tab, c[1], 'Yes')]);
    summary.push(['Converted \u2014 No',   ansCount(tab, c[1], 'No')]);
    summary.push(['', '']);
  });

  sh.getRange(1,1,summary.length,2).setValues(summary);
  sh.getRange(1,1,1,2).merge().setFontSize(14).setFontWeight('bold')
    .setFontColor('#ffffff').setBackground('#E23744').setHorizontalAlignment('center');
  // highlight every section header row
  for (var si = 0; si < summary.length; si++) {
    var lbl = String(summary[si][0]||'');
    if (lbl && summary[si][1] === '' && lbl === lbl.toUpperCase() && si > 0) {
      sh.getRange(si+1,1,1,2).merge().setFontWeight('bold').setBackground('#FEF3C7').setFontColor('#92400E');
    }
  }
  sh.getRange(2,1,summary.length-1,1).setFontWeight('bold');
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 180);

  // ---------- audit log ----------
  try { logLeadList_(context, period, scope, scopeLabel, ss.getUrl(), name, built, tabMeta, ss.getId()); } catch (e) {}

  // ---------- record for the download cooldown ----------
  try { leadCooldownRecord_(context.email, period, scope, opts.kam, ss.getUrl(), name); } catch (e) {}
  try { registerSelfMadeLeadDrive_({ rv:leadRv, creator:context.email, name:name, url:ss.getUrl(), leadTab:'Summary', rows:built.rows }); } catch (e) {}

  return { status:'OK', url: ss.getUrl(), name: name, count: built.rows.length, note: folderNote };
}

// Write a lead sheet: header styling, freeze, filter, Yes/No dropdowns.
function writeLeadSheet_(sh, head, data, dropdownCols) {
  sh.getRange(1,1,1,head.length).setValues([head])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#E23744')
    .setVerticalAlignment('middle').setWrap(true);
  // Identity columns are visually separated from performance metrics, while
  // the three working fields always stand out on the far right.
  var identityCols = Math.min(6, head.length);
  if (identityCols) sh.getRange(1,1,1,identityCols).setBackground('#123B5D').setFontColor('#FFFFFF');
  if (head.length > 6) sh.getRange(1,7,1,Math.min(4,head.length-6)).setBackground('#4C1D95').setFontColor('#FFFFFF');
  if (head.length >= 3) sh.getRange(1,head.length-2,1,3).setBackground('#F5B301').setFontColor('#1A1A1A');
  var zvdHeader = head.indexOf('ZVD/SV Current %');
  if (zvdHeader !== -1) sh.getRange(1,zvdHeader+1,1,1).setBackground('#B91C1C').setFontColor('#FFFFFF');
  if (data.length) sh.getRange(2,1,data.length,head.length).setValues(data);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(3);
  try { sh.getRange(1,1,Math.max(data.length+1,2),head.length).createFilter(); } catch(e) {}

  // Yes/No dropdowns on the tracking columns
  if (data.length && dropdownCols && dropdownCols.length) {
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(['Yes','No'], true).setAllowInvalid(false).build();
    dropdownCols.forEach(function(c){
      if (c <= head.length) sh.getRange(2,c,data.length,1).setDataValidation(rule);
    });
  }
  // Source values are already expressed as 5.4 = 5.4%, so use a literal
  // percent sign (never the spreadsheet % multiplier). Keep 1 decimal with
  // an optional second decimal across every percentage column.
  if (data.length) {
    head.forEach(function(h, i){
      var label = String(h||'');
      var range = sh.getRange(2,i+1,data.length,1);
      if (label.indexOf('%') !== -1) range.setNumberFormat('0.0#"%"');
      else if (label.indexOf('₹') !== -1) range.setNumberFormat('#,##0.0#');
      else if (/Increase Needed|Gap/.test(label)) range.setNumberFormat('0.0#');
    });
  }
  // priority colour
  if (data.length) {
    var pr = sh.getRange(2,1,data.length,1);
    var rules = [
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('P0').setBackground('#FEE2E2').setFontColor('#991B1B').setRanges([pr]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('P1').setBackground('#FEF3C7').setFontColor('#92400E').setRanges([pr]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('P2').setBackground('#F3F4F6').setFontColor('#374151').setRanges([pr]).build()
    ];
    sh.setConditionalFormatRules(rules);
  }
  for (var i=1;i<=head.length;i++) sh.autoResizeColumn(i);
}

// Monthly audit log: one sheet per month in the log folder, one row per
// generated lead list, with live formulas pulling the Yes counts back from it.
function logLeadList_(context, period, scope, scopeLabel, url, name, built, tabMeta, ssId) {
  var tz = Session.getScriptTimeZone();
  var monthTag = Utilities.formatDate(new Date(), tz, 'MMM-yyyy');
  var clusterTag = (typeof CLUSTER_LABEL !== 'undefined' && CLUSTER_LABEL) ? CLUSTER_LABEL : 'ROM';
  var logName = 'Lead List Log \u2014 ' + clusterTag + ' \u2014 ' + monthTag;

  var folder = DriveApp.getFolderById(LEADLIST_LOG_FOLDER_ID);
  var ss, it = folder.getFilesByName(logName);
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(logName);
    var f = DriveApp.getFileById(ss.getId());
    try {
      var movedLog = false;
      try { if (f.moveTo) { f.moveTo(folder); movedLog = true; } } catch (eM) { movedLog = false; }
      if (!movedLog) { folder.addFile(f); try { DriveApp.getRootFolder().removeFile(f); } catch (e2) {} }
    } catch (e) {}
    try { f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT); } catch (e) {}
    var sh0 = ss.getActiveSheet();
    sh0.setName('Log');
    var hdr = ['Date & Time','User','Scope','Period','Restaurants','P0','P1','P2',
               'MVD-SV: total','MVD-SV: approached','MVD-SV: converted','MVD-SV: uploaded',
               'Ads-CV: total','Ads-CV: approached','Ads-CV: converted','Ads-CV: uploaded',
               'Menu: total','Menu: approached','Menu: converted','Menu: uploaded',
               'Lead List','Sheet name','Sheet ID','Column map'];
    sh0.getRange(1,1,1,hdr.length).setValues([hdr])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#E23744').setWrap(true);
    sh0.setFrozenRows(1);
  }
  var sh = ss.getSheetByName('Log') || ss.getActiveSheet();

  var cnt = function(f){ var c=0; built.rows.forEach(function(r){ if(f(r)) c++; }); return c; };
  var colLetter = function(n){ var s2=''; while(n>0){ var m=(n-1)%26; s2=String.fromCharCode(65+m)+s2; n=(n-m-1)/26; } return s2; };
  // live link back into the generated sheet: counts update when the team fills it
  // Counts start at 0 and are filled in by refreshLeadListLog() (which reads the
  // sheets directly). IMPORTRANGE is avoided because it needs a manual
  // "Allow access" click on every new file.
  var totalOf = function(tab){ return tabMeta[tab] ? tabMeta[tab].rows : 0; };

  // column map so the refresh job knows where the Yes/No columns live
  var colMap = ['MVD-SV','Ads-CV','Menu Score'].map(function(t){
    return t + ':' + (tabMeta[t] ? tabMeta[t].cols.join('-') : '');
  }).join(';');

  sh.appendRow([
    Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm'),
    context.email || '', scopeLabel || scope, period.toUpperCase(),
    built.rows.length,
    cnt(function(r){ return r.priority==='P0'; }),
    cnt(function(r){ return r.priority==='P1'; }),
    cnt(function(r){ return r.priority==='P2'; }),
    totalOf('MVD-SV'),    0, 0, 0,
    totalOf('Ads-CV'),    0, 0, 0,
    totalOf('Menu Score'),0, 0, 0,
    url, name, ssId, colMap
  ]);
}

// Endpoint: list of KAMs the admin can pick for a lead list.
function getLeadKamList() {
  var context = getUserContext();
  if (!context.isAdmin) return { status:'FORBIDDEN', kams: [] };
  var out = {};
  try {
    var pf = readPeriodFile('month') || readPeriodFile('week') || readPeriodFile('day');
    if (pf) {
      parseData(pf.csv).forEach(function(r){
        var a = String(r.am||'').toLowerCase().trim();
        if (a && a !== 'n/a' && a !== 'no_am' && a.indexOf('@') !== -1) out[a] = 1;
      });
    }
  } catch (e) {}
  return { status:'OK', kams: Object.keys(out).sort() };
}

// CEO/Super scope picker for lead-list exports.
function getLeadScopes(viewer, clusterOverride) {
  var email = String(viewer||'').toLowerCase().trim() || getCurrentEmail_();
  var rv = resolveViewer_(email, clusterOverride);
  if (rv.role !== 'ceo' && rv.role !== 'super') return { status:'OK', role:rv.role, scopes:[], zhs:[], kams:[] };
  var scopes = [{ value:'', label:'Whole Cluster' }];
  (rv.zhs||[]).filter(Boolean).sort().forEach(function(z){ scopes.push({value:'zh:'+z,label:'ZH · '+z.split('@')[0]}); });
  (rv.kams||[]).filter(Boolean).sort().forEach(function(k){ scopes.push({value:k,label:'KAM · '+k.split('@')[0]}); });
  return { status:'OK', role:rv.role, scopes:scopes, zhs:(rv.zhs||[]).filter(Boolean).sort(), kams:(rv.kams||[]).filter(Boolean).sort() };
}

/**
 * ONE-TIME SETUP — run this manually from the Apps Script editor.
 *
 *   1. Open the editor, pick "AUTHORIZE_ALL_PERMISSIONS" in the function
 *      dropdown at the top, then press Run.
 *   2. Google will show a consent screen. Choose your account ->
 *      "Advanced" -> "Go to <project> (unsafe)" -> Allow.
 *   3. Check the execution log: every line should say OK.
 *
 * It touches each service the dashboard needs so Google asks for all the
 * scopes at once (Drive, Sheets, Gmail, Cache, Properties).
 */
function AUTHORIZE_ALL_PERMISSIONS() {
  var log = [];
  var step = function(name, fn){
    try { fn(); log.push('OK   - ' + name); }
    catch (e) { log.push('FAIL - ' + name + ' :: ' + (e && e.message ? e.message : e)); }
  };

  step('Identify user', function(){ Session.getActiveUser().getEmail(); });
  step('Read data folder', function(){ var f=getCacheFolder(); if(f) f.getName(); });
  step('Read lead-list folder', function(){ DriveApp.getFolderById(LEADLIST_FOLDER_ID).getName(); });
  step('Read log folder', function(){ DriveApp.getFolderById(LEADLIST_LOG_FOLDER_ID).getName(); });

  // create a throwaway sheet, exercise the folder APIs, then delete it.
  // The file is trashed at the end so nothing is left behind.
  step('Create + move + delete a test sheet', function(){
    var ss = SpreadsheetApp.create('Brahmastra permission test (auto-deleted)');
    var id = ss.getId();
    var f  = DriveApp.getFileById(id);
    var folder = DriveApp.getFolderById(LEADLIST_FOLDER_ID);
    try {
      // touch the same APIs the lead list uses, then undo the move
      folder.addFile(f);
      folder.removeFile(f);
    } catch (e) {}
    try { f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT); } catch (e) {}
    // always bin it (works whether or not the move succeeded)
    DriveApp.getFileById(id).setTrashed(true);
  });

  step('Cache service', function(){ CacheService.getScriptCache().put('perm_check', '1', 60); });
  step('Script properties', function(){ PropertiesService.getScriptProperties().getProperty('ONLINE_USERS'); });
  step('Spreadsheet edit triggers', function(){ ScriptApp.getProjectTriggers(); });
  step('Spreadsheet tracker', function(){ SpreadsheetApp.openById(TRACKER_SHEET_ID).getName(); });
  step('Gmail (digest emails)', function(){ GmailApp.getAliases(); });

  var out = log.join('\n');
  Logger.log(out);
  return out;
}

/**
 * Refresh the Approached / Converted / Uploaded counts in this month's log.
 *
 * Run it manually from the editor, or set a time-driven trigger (e.g. hourly)
 * so the log stays current without anyone clicking anything.
 * It opens each lead list recorded in the log and counts the "Yes" answers.
 */
function refreshLeadListLog() {
  var tz = Session.getScriptTimeZone();
  var monthTag = Utilities.formatDate(new Date(), tz, 'MMM-yyyy');
  var clusterTag = (typeof CLUSTER_LABEL !== 'undefined' && CLUSTER_LABEL) ? CLUSTER_LABEL : 'ROM';
  var logName = 'Lead List Log \u2014 ' + clusterTag + ' \u2014 ' + monthTag;

  var folder = DriveApp.getFolderById(LEADLIST_LOG_FOLDER_ID);
  var it = folder.getFilesByName(logName);
  if (!it.hasNext()) return 'No log sheet for ' + monthTag;

  var ss = SpreadsheetApp.open(it.next());
  var sh = ss.getSheetByName('Log') || ss.getActiveSheet();
  var last = sh.getLastRow();
  if (last < 2) return 'Log is empty';

  var ID_COL = 23, MAP_COL = 24;              // 'Sheet ID', 'Column map'
  var vals = sh.getRange(2, 1, last - 1, MAP_COL).getValues();
  var updated = 0;

  for (var i = 0; i < vals.length; i++) {
    var sheetId = String(vals[i][ID_COL - 1] || '').trim();
    var colMap  = String(vals[i][MAP_COL - 1] || '').trim();
    if (!sheetId || !colMap) continue;

    var target;
    try { target = SpreadsheetApp.openById(sheetId); }
    catch (e) { continue; }                   // deleted or no access — skip

    // colMap looks like  "MVD-SV:17-18-19;Ads-CV:16-17-18;Menu Score:17-18-19"
    var counts = {};
    colMap.split(';').forEach(function(part){
      var bits = part.split(':');
      var tab = bits[0];
      if (!bits[1]) { counts[tab] = [0,0,0]; return; }
      var cols = bits[1].split('-').map(Number);
      var tsh = target.getSheetByName(tab);
      if (!tsh || tsh.getLastRow() < 2) { counts[tab] = [0,0,0]; return; }
      var n = tsh.getLastRow() - 1;
      var got = [0,0,0];
      cols.forEach(function(c, idx){
        if (!c) return;
        var col = tsh.getRange(2, c, n, 1).getValues();
        var yes = 0;
        for (var r = 0; r < col.length; r++) {
          if (String(col[r][0]).trim().toLowerCase() === 'yes') yes++;
        }
        got[idx] = yes;
      });
      counts[tab] = got;
    });

    var mv = counts['MVD-SV']     || [0,0,0];
    var ad = counts['Ads-CV']     || [0,0,0];
    var mn = counts['Menu Score'] || [0,0,0];
    // columns 10-12 (MVD), 14-16 (Ads), 18-20 (Menu)
    sh.getRange(i + 2, 10, 1, 3).setValues([mv]);
    sh.getRange(i + 2, 14, 1, 3).setValues([ad]);
    sh.getRange(i + 2, 18, 1, 3).setValues([mn]);
    updated++;
  }
  return 'Refreshed ' + updated + ' lead list(s) in ' + logName;
}

/**
 * DIAGNOSTIC — run manually to see what each metrics file actually contains.
 * Tells you the file found, its headers, and whether the new columns parsed.
 */
function CHECK_METRIC_FILES() {
  var out = [];
  ['day','week','month'].forEach(function(p){
    out.push('--- ' + p.toUpperCase() + ' ---');
    var f = readMetricFile(p);
    if (!f) {
      out.push('  FILE NOT FOUND. Expected current_month_<cluster>_DD_MM.csv');
      return;
    }
    out.push('  file: ' + f.name);
    var lines = String(f.csv).replace(/\r/g,'').split('\n');
    var hdr = lines[0] || '';
    out.push('  headers: ' + hdr.slice(0, 400));
    // which of the new columns are present?
    var want = ['res_rating','otr','total_menu_items','items_without_image',
                'items_without_description','final_menu_score','image_score',
                'description_score','cuisine'];
    var low = hdr.toLowerCase();
    var missing = want.filter(function(c){ return low.indexOf(c) === -1; });
    out.push('  missing columns: ' + (missing.length ? missing.join(', ') : 'none'));
    // parse and show one row
    var map = parseMetrics(f.csv);
    var keys = Object.keys(map);
    out.push('  rows parsed: ' + keys.length);
    if (keys.length) {
      var m = map[keys[0]];
      out.push('  sample res_id ' + keys[0] + ': rating=' + m.rating + ' otr=' + m.otr +
               ' menuScore=' + m.menuScore + ' items=' + m.menuItems +
               ' noImage=' + m.noImage + ' noDesc=' + m.noDesc + ' cuisine=' + m.cuisine);
      // how many rows actually have a rating?
      var withRating = 0, withMenu = 0;
      keys.forEach(function(k){
        if (map[k].rating > 0) withRating++;
        if (map[k].menuScore > 0) withMenu++;
      });
      out.push('  rows with rating>0: ' + withRating + ' / ' + keys.length);
      out.push('  rows with menuScore>0: ' + withMenu + ' / ' + keys.length);
    }
  });
  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

// Run manually after uploading a new deep-dive CSV.  This proves the exact
// source file selected for the active cluster and whether JSON cells survived
// CSV parsing, so a stale/incorrectly-named file is immediately visible.
function CHECK_DEEPDIVE_JSON() {
  var out = [];
  ['month','week'].forEach(function(period){
    var f = readMetricFile(period);
    out.push('--- ' + period.toUpperCase() + ' ---');
    if (!f) { out.push('NO FILE'); return; }
    out.push('FILE: ' + f.name);
    var hdr = String(f.csv || '').split(/\r?\n/)[0] || '';
    ['status_json','hygiene_json','funnel_metrics_json','nrl_orders_json','pg_orders_json','mealtime_orders_json','ads_metrics'].forEach(function(key){
      out.push(key + ': ' + (hdr.toLowerCase().indexOf(key) >= 0 ? 'HEADER FOUND' : 'MISSING'));
    });
    var map = period === 'week' ? parseMetricsWeek_(f.csv, 0) : parseMetrics(f.csv);
    var ids = Object.keys(map), m = ids.length ? map[ids[0]] : null;
    out.push('PARSED RESTAURANTS: ' + ids.length);
    if (m) out.push('SAMPLE ' + ids[0] + ': rating=' + m.rating + ', new=' + m.newOrders + ', pg7_10=' + m.pg710 + ', breakfast=' + m.breakfastOrders + ', actualMVD=' + m.actual_mvd_sv + ', intendedMVD=' + m.intended_mvd_sv + ', actualMshare=' + m.actual_mshare + ', intendedMshare=' + m.intended_mshare + ', growMaxx=' + m.growMaxxModel + ', autoRenewal=' + m.autoRenewal);
  });
  var result = out.join('\n');
  Logger.log(result);
  return result;
}

// Convenience diagnostic for the supplied Maharashtra cluster data.  Super
// Core is deliberately a separate aggregate source and will not contain the
// restaurant JSON columns.
function CHECK_DEEPDIVE_JSON_MAHARASHTRA() {
  setViewer_(getCurrentEmail_());
  setClusterOverride_('maharashtra');
  return CHECK_DEEPDIVE_JSON();
}

/**
 * DIAGNOSTIC — lists every CSV in the data folder and tests each lookup.
 * Run manually, then read the execution log.
 */
function CHECK_FOLDER_FILES() {
  var out = [];
  var folder = getCacheFolder();
  out.push('Folder: ' + folder.getName() + '  (id ' + folder.getId() + ')');

  // 1) everything that is actually in there
  var names = [];
  var it = folder.getFiles();
  while (it.hasNext()) names.push(it.next().getName());
  names.sort();
  out.push('');
  out.push('FILES IN FOLDER (' + names.length + '):');
  names.forEach(function(n){ out.push('  ' + n); });

  // 2) what the code looks for, and whether it lands
  out.push('');
  out.push('METRIC FILE LOOKUP:');
  ['day','week','month'].forEach(function(p){
    var f = readMetricFile(p);
    out.push('  ' + p + ' -> ' + (f ? ('FOUND ' + f.name) : 'NOT FOUND'));
    if (f) {
      var map = parseMetrics(f.csv);
      var keys = Object.keys(map);
      var withRating = 0, withMenu = 0;
      keys.forEach(function(k){
        if (map[k].rating > 0) withRating++;
        if (map[k].menuScore > 0) withMenu++;
      });
      out.push('      rows=' + keys.length + '  rating>0: ' + withRating + '  menuScore>0: ' + withMenu);
      if (keys.length) {
        var m = map[keys[0]];
        out.push('      sample id=' + keys[0] + ' rating=' + m.rating + ' otr=' + m.otr +
                 ' menuScore=' + m.menuScore + ' items=' + m.menuItems + ' cuisine=' + m.cuisine);
      }
      out.push('      headers: ' + String(f.csv).split('\n')[0].slice(0, 300));
    }
  });

  out.push('');
  out.push('COMPARISON (last period) FILE LOOKUP:');
  ['day','week','month'].forEach(function(p){
    var f = readLastMetricFile_(p);
    out.push('  ' + p + ' -> ' + (f ? ('FOUND ' + f.name) : 'NOT FOUND'));
  });

  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

/**
 * Clear the dashboard's cached payload. Run this after changing files or code
 * if the dashboard still shows old data.
 */
/**
 * DIAGNOSTIC — shows exactly what getAllPeriods() hands to the dashboard.
 * Use this when the backend can read a file but the UI still shows nothing.
 */
function CHECK_WHAT_UI_GETS() {
  var out = [];
  var r = getAllPeriods();
  out.push('cached: ' + r.cached);
  out.push('context: ' + (r.context ? r.context.email + ' admin=' + r.context.isAdmin : 'none'));
  out.push('');
  out.push('PERIOD ROW COUNTS:');
  ['day','week','month','quarter'].forEach(function(p){
    var rows = r.periods ? r.periods[p] : null;
    out.push('  ' + p + ': ' + (rows ? rows.length + ' rows' : 'null'));
  });
  out.push('');
  out.push('METRICS (what the deep-dive reads):');
  ['day','week','month'].forEach(function(p){
    var m = (r.metrics || {})[p] || {};
    var keys = Object.keys(m);
    var withRating = 0, withMenu = 0, withOtr = 0;
    keys.forEach(function(k){
      if (m[k].rating > 0) withRating++;
      if (m[k].menuScore > 0) withMenu++;
      if (m[k].otr > 0) withOtr++;
    });
    out.push('  ' + p + ': ' + keys.length + ' res_ids | rating>0: ' + withRating +
             ' | otr>0: ' + withOtr + ' | menuScore>0: ' + withMenu);
    if (keys.length) {
      var s = m[keys[0]];
      out.push('      sample id=' + keys[0] + ' name=' + s.nmDisp +
               ' rating=' + s.rating + ' otr=' + s.otr + ' menuScore=' + s.menuScore +
               ' items=' + s.menuItems + ' cuisine=' + s.cuisine);
    }
  });
  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

function CLEAR_CACHE() {
  try {
    var cache = CacheService.getScriptCache();
    var keys = ['allPeriods_v3_unscoped', 'allPeriods_v2', 'allPeriods_v1'];
    keys.forEach(function(k){
      cache.remove(k);
      cache.remove(k + '__sig');
      cache.remove(k + '__n');
      for (var i = 0; i < 40; i++) cache.remove(k + '__' + i);
    });
    return 'Cache cleared. Reload the dashboard.';
  } catch (e) {
    return 'Could not clear cache: ' + (e && e.message ? e.message : e);
  }
}

/**
 * Cluster-level actionable summary for the Targets page.
 * Reuses the lead-list diagnosis, then rolls it up into "why is NOV down"
 * buckets with a restaurant count and the benchmark behind each one.
 */
function getActionableSummary(period, viewer) {
  setViewer_(viewer);
  var context;
  try { context = getUserContext(); } catch (e) { context = { email:'', isAdmin:false }; }
  if (['day','week','month'].indexOf(period) === -1) period = 'month';

  var built;
  try { built = buildLeadRows_(period, context, {}); }
  catch (e) { return { status:'ERR', buckets:[], total:0 }; }

  var rows = built.rows || [];
  var scopeLbl = context.isAdmin ? 'Whole cluster'
               : ((context.email || '').split('@')[0] + "'s portfolio");
  if (!rows.length) return { status:'OK', period:period, total:0, buckets:[],
                             scope: context.isAdmin ? 'cluster' : 'own', scopeLabel: scopeLbl };

  var mvd = [], ads = [], menu = [], engines = [], vis = [], subsidy = [], combo = [];
  rows.forEach(function(r){
    if (r.mvdUplift > 0) mvd.push(r);
    if (r.adsUplift > 0) ads.push(r);
    if (r.descCov < 80 || r.imgCov < 60) menu.push(r);
    if (r.enginesOff) engines.push(r);
    if (r.vis > 0 && r.vis < 95) vis.push(r);
    if (r.subsidyTrap) subsidy.push(r);
    if (r.comboNeeded) combo.push(r);
  });

  var avg = function(list, f){
    if (!list.length) return 0;
    var s = 0; list.forEach(function(r){ s += (f(r) || 0); });
    return s / list.length;
  };
  var pct = function(n){ return rows.length ? Math.round(n / rows.length * 100) : 0; };

  var buckets = [];
  if (mvd.length) buckets.push({
    key:'mvd', tag:'MVD / SV', count:mvd.length, share:pct(mvd.length),
    title:'MVD below peers',
    why:'Some brands are running MVD/SV well under the average for their cuisine in their city, so C2O suffers.',
    action:'Generate the lead list and work through the MVD tab \u2014 it shows each brand\'s current MVD/SV and the target to move to.'
  });
  if (ads.length) buckets.push({
    key:'ads', tag:'Ads / CV', count:ads.length, share:pct(ads.length),
    title:'Ad spend below peers',
    why:'Some brands spend noticeably less on ads than similar outlets in the same city, so they lose visibility.',
    action:'Generate the lead list and open the Ads tab \u2014 it lists the brands to push and the spend level to aim for.'
  });
  if (menu.length || combo.length) {
    var menuSet = {};
    menu.forEach(function(r){ menuSet[r.resId] = r; });
    combo.forEach(function(r){ menuSet[r.resId] = r; });
    var menuAll = Object.keys(menuSet).map(function(k){ return menuSet[k]; });
    var why = [];
    if (menu.length) why.push('missing item images or descriptions');
    if (combo.length) why.push('weak menu-to-cart conversion');
    var todo = [];
    if (menu.length) todo.push('add the missing images and descriptions');
    if (combo.length) todo.push('create 2-3 combo meals to lift perceived value');
    buckets.push({
      key:'menu', tag:'Menu / M2C', count:menuAll.length, share:pct(menuAll.length),
      title:'Menu holding M2C back',
      why: 'Some brands have ' + why.join(' and ') + ', which drags menu-to-cart down.',
      action: 'Generate the lead list and open the Menu tab \u2014 ' + todo.join(', and ') + '.'
    });
  }
  if (engines.length) buckets.push({
    key:'engines', tag:'Engines', count:engines.length, share:pct(engines.length),
    title:'Growth engines not live',
    why:'A few brands have PE, Salt or MVD switched off, so nothing else can compound.',
    action:'Generate the lead list and switch these on first \u2014 they are the quickest wins.'
  });
  if (subsidy.length) buckets.push({
    key:'subsidy', tag:'ARPO vs ZVD', count:subsidy.length, share:pct(subsidy.length),
    title:'Ads not covering the burn',
    why:'Some brands earn less ad revenue per order than they give away in ZVD, so every order loses money.',
    action:'Generate the lead list and raise the ads budget on those brands until ARPO clears ZVD per order.'
  });
  if (vis.length) buckets.push({
    key:'vis', tag:'Visibility', count:vis.length, share:pct(vis.length),
    title:'Low visibility on Zomato',
    why:'Some brands are not fully visible to customers, so orders are lost before the funnel even starts.',
    action:'Generate the lead list and check listing status and availability for those brands.'
  });

  buckets.sort(function(a,b){ return b.count - a.count; });
  return { status:'OK', period:period, total: rows.length, buckets: buckets,
           scope: context.isAdmin ? 'cluster' : 'own', scopeLabel: scopeLbl };
}

/**
 * Per-restaurant actionables, keyed by res_id — used by the Top Gaps panel so
 * each outlet card can show why it is behind.
 */
function getResActionables(period, viewer) {
  setViewer_(viewer);
  var context;
  try { context = getUserContext(); } catch (e) { context = { email:'', isAdmin:false }; }
  if (['day','week','month'].indexOf(period) === -1) period = 'month';

  var map = {};
  try {
    var built = buildLeadRows_(period, context, {});
    (built.rows || []).forEach(function(r){
      map[r.resId] = {
        priority: r.priority,
        actions: r.actions,
        mvdSv: +(r.mvdSv || 0).toFixed(2),
        mvdTarget: +(r.mvdTarget || 0).toFixed(2),
        adsCv: +(r.adsCv || 0).toFixed(2),
        peerAdsAvg: +(r.peerAdsAvg || 0).toFixed(2),
        descCov: Math.round(r.descCov || 0),
        imgCov: Math.round(r.imgCov || 0),
        vis: +(r.vis || 0).toFixed(1),
        arpo: Math.round(r.arpo || 0),
        zvdPerOrder: Math.round(r.zvdPerOrder || 0),
        subsidyTrap: !!r.subsidyTrap,
        m2c: +(r.m2c || 0).toFixed(1),
        comboNeeded: !!r.comboNeeded,
        enginesOff: !!r.enginesOff
      };
    });
  } catch (e) { /* return whatever we have */ }
  return { status:'OK', period:period, map: map };
}

/**
 * ---------------------------------------------------------------------------
 * NOV levers + Value/refund buckets for the "How to reach NOV target?" panel.
 *
 * Returns one entry per bucket: { key, label, count, hasData, leads:[...] }.
 * A bucket is a specific problem set (e.g. Visibility < 95%, ordered last
 * period but not this one, MVD/SV below peer, etc.). Each lead row is at
 * res_id level and carries the columns the CSV export needs.
 *
 * Metrics whose source columns are not in the data yet (price parity, chalo
 * 49-149, acquisition, packaging charges, refunds) come back with
 * hasData:false and count 0 — the UI shows them as "awaiting data" and they
 * light up automatically once the column starts arriving.
 * ---------------------------------------------------------------------------
 */
function getNovBuckets(period, viewer) {
  setViewer_(viewer);
  var context;
  try { context = getUserContext(); } catch (e) { context = { email:'', isAdmin:false }; }
  if (['day','week','month','quarter'].indexOf(period) === -1) period = 'month';
  // metric comparison files only exist for day/week/month; quarter falls back to month
  var mPeriod = (period === 'quarter') ? 'month' : period;

  var map = {};
  try { map = parseMetricsCached_(mPeriod) || {}; } catch (e) { map = {}; }

  // last-period metrics (for the "ordered last period, not now" lapse logic)
  var lastMap = {};
  try {
    var lf = readLastMetricFile_(mPeriod);
    if (lf) lastMap = parseMetrics(lf.csv);
  } catch (e) {}

  // fallback details (name/city/kam/cuisine) from the period file
  var info = {};
  try {
    var pf = readPeriodFile(mPeriod);
    if (pf) parseData(pf.csv).forEach(function(r){
      var rid = String(r.resId||'').trim();
      if (!rid || info[rid]) return;
      info[rid] = { res:r.restaurant||'', city:r.city||'', cuisine:r.cuisine||'',
                    am:String(r.am||'').toLowerCase(), tl:String(r.tl||'').toLowerCase() };
    });
  } catch (e) {}

  var me = String(context.email||'').toLowerCase();

  // bucket accumulators
  var B = {
    activeRes:  [], visibility: [], mvdsv: [], salt: [],
    priceParity: [], chalo: [], acquisition: [], pc: [],
    adscv: [], commValue: [], zvdsv: [], refund: []
  };
  // which buckets have a real source column present anywhere in the data
  var seen = { salt:false, mvdsv:false, visibility:false, adscv:false, commValue:false, zvdsv:false, activeRes:false,
               priceParity:false, chalo:false, acquisition:false, pc:false, refund:false };

  for (var id in map) {
    var m = map[id];
    var fb = info[id] || {};
    var amE = String(m.am || fb.am || '').toLowerCase();
    var tlE = String(m.tl || fb.tl || '').toLowerCase();
    // role scope: non-admins only see their own restaurants
    if (!context.isAdmin && amE !== me && tlE !== me) continue;

    var resN = m.nmDisp || m.nm || fb.res || '';
    var cityN = m.city || fb.city || '';
    var cuis  = m.cuisine || fb.cuisine || '';
    var kam   = amE || tlE || '';
    var base  = { id:id, name:resN, city:cityN, kam:kam, cuisine:cuis };

    var sv = m.sv||0, cv = m.cv||0, orders = m.total_orders||0;
    var lm = lastMap[id];
    var lastOrders = lm ? (lm.total_orders||0) : 0;

    // 1) Active Res: ordered last period but not this one (lapsed)
    if (lm) { seen.activeRes = true;
      if (lastOrders > 0 && orders === 0)
        B.activeRes.push(mkLead_(base, orders, lastOrders));
    }

    // 2) Visibility < 95% (expected vs actual online presence proxy)
    var vis = (m.expected||0) > 0 ? ((m.actual||0)/(m.expected||1)*100) : -1;
    if (vis >= 0) { seen.visibility = true;
      if (vis < 95) B.visibility.push(mkLead_(base, +vis.toFixed(1), 95));
    }

    // 3) MVD/SV below intended (or 0)
    var mvdSv = sv > 0 ? (m.mvdAmt/sv*100) : parseFloat(m.actual_mvd_sv||0);
    var intMvd = parseFloat(m.intended_mvd_sv||0);
    if (sv > 0 || m.actual_mvd_sv !== '' ) { seen.mvdsv = true;
      if (intMvd > 0 && mvdSv < intMvd) B.mvdsv.push(mkLead_(base, +mvdSv.toFixed(1), +intMvd.toFixed(1)));
      else if (intMvd === 0 && mvdSv === 0 && sv > 0) B.mvdsv.push(mkLead_(base, 0, 0));
    }

    // 4) Salt not live (salt_status = 0, with a real raw value)
    if (String(m.saltRaw||'') !== '') { seen.salt = true;
      if (m.salt === 0) B.salt.push(mkLead_(base, 0, 1));
    }

    // ---- value / refund group ----
    // Ads/CV below peer handled UI-side via count; here flag zero-ads earners
    var adsCv = cv > 0 ? (m.ad_rev/cv*100) : -1;
    if (adsCv >= 0) { seen.adscv = true;
      if (adsCv < 1) B.adscv.push(mkLead_(base, +adsCv.toFixed(2), 1));
    }
    // Commissionable value present but low/zero while orders exist
    if (m.hasOwnProperty('cv')) { seen.commValue = true;
      if (orders > 0 && cv === 0) B.commValue.push(mkLead_(base, 0, orders));
    }
    // ZVD/SV — subsidy load; flag high ZVD/SV (subsidy trap)
    var zvdSv = sv > 0 ? ((m.zvdAmt||0)/sv*100) : -1;
    if (zvdSv >= 0 && (m.zvdAmt||0) > 0) { seen.zvdsv = true;
      if (zvdSv > 0) B.zvdsv.push(mkLead_(base, +zvdSv.toFixed(1), 0));
    }
    // Price parity / chalo / acquisition / PC / refund: no source columns yet.
  }

  function pack(key, label, arr, dataFlag, sortDesc) {
    arr.sort(function(a,b){ return sortDesc ? (b.cmVal - a.cmVal) : (a.cmVal - b.cmVal); });
    return { key:key, label:label, count:arr.length, hasData: !!dataFlag, leads: arr };
  }

  var nov = [
    pack('activeRes',   'Active Res',        B.activeRes,   seen.activeRes,  true),
    pack('visibility',  'Visibility <95%',   B.visibility,  seen.visibility, false),
    pack('mvdsv',       'MVD/SV',            B.mvdsv,       seen.mvdsv,      false),
    pack('salt',        'Salt',              B.salt,        seen.salt,       false),
    pack('priceParity', 'Price Parity',      B.priceParity, false,           false),
    pack('acquisition', 'Acquisition',       B.acquisition, false,           false),
    pack('pc',          'Packaging (PC)',    B.pc,          false,           false)
  ];
  var val = [
    pack('adscv',     'Ads/CV',                     B.adscv,     seen.adscv,     false),
    pack('commValue', 'Commission Revenue',         B.commValue, seen.commValue, true),
    pack('zvdsv',     'ZVD/SV',                     B.zvdsv,     seen.zvdsv,     true),
    pack('refund',    'Merchant & Customer Refund', B.refund,    false,          true)
  ];

  return { status:'OK', period:period, isAdmin:!!context.isAdmin, nov:nov, val:val };
}

// small helper to shape a lead row consistently
function mkLead_(base, cmVal, lmVal) {
  return { id:base.id, name:base.name, city:base.city, kam:base.kam, tl:base.tl||'', cluster:base.cluster||'',
           cuisine:base.cuisine, cmVal:cmVal, lmVal:lmVal,
           orders:base.orders||0, cityOv:base.cityOv||0, portfolioOv:base.portfolioOv||0, orderContribution:base.orderContribution||0,
           mxRefund:base.mxRefund||0, cxRefund:base.cxRefund||0 };
}

/**
 * ---------------------------------------------------------------------------
 * War Room: detects outlets whose orders / commissionable value / MVD dropped
 * vs the last comparable period, grouped by dimension (overall, city, cuisine,
 * zh/tl, kam). Each group carries counts of red / yellow / mild drops plus the
 * lead rows so the UI can export them.
 * ---------------------------------------------------------------------------
 */
function getWarRoom(period, viewer) {
  setViewer_(viewer);
  var context;
  try { context = getUserContext(); } catch (e) { context = { email:'', isAdmin:false }; }
  if (['day','week','month','quarter'].indexOf(period) === -1) period = 'month';
  var mPeriod = (period === 'quarter') ? 'month' : period;

  var map = {}, lastMap = {};
  try { map = parseMetricsCached_(mPeriod) || {}; } catch (e) {}
  try { var lf = readLastMetricFile_(mPeriod); if (lf) lastMap = parseMetrics(lf.csv); } catch (e) {}

  var info = {};
  try {
    var pf = readPeriodFile(mPeriod);
    if (pf) parseData(pf.csv).forEach(function(r){
      var rid = String(r.resId||'').trim();
      if (!rid || info[rid]) return;
      info[rid] = { res:r.restaurant||'', city:r.city||'', cuisine:r.cuisine||'',
                    am:String(r.am||'').toLowerCase(), tl:String(r.tl||'').toLowerCase() };
    });
  } catch (e) {}

  var me = String(context.email||'').toLowerCase();

  // dimension -> entity name -> { red, yellow, mild, leads[] }
  var dims = { overall:{}, city:{}, cuisine:{}, zh:{}, kam:{} };
  function bump(dim, name, grade, lead){
    if (!name) return;
    var d = dims[dim];
    if (!d[name]) d[name] = { name:name, red:0, yellow:0, mild:0, leads:[] };
    d[name][grade]++;
    d[name].leads.push(lead);
  }

  for (var id in map) {
    var m = map[id], fb = info[id] || {};
    var amE = String(m.am || fb.am || '').toLowerCase();
    var tlE = String(m.tl || fb.tl || '').toLowerCase();
    if (!context.isAdmin && amE !== me && tlE !== me) continue;

    var lm = lastMap[id];
    if (!lm) continue;                       // need a comparison point
    var cur = m.total_orders||0, prev = lm.total_orders||0;
    if (prev <= 0) continue;
    var dropPct = (prev - cur) / prev * 100;  // positive = dropped
    if (dropPct <= 3) continue;               // ignore noise / growth
    var grade = dropPct >= 40 ? 'red' : (dropPct >= 15 ? 'yellow' : 'mild');

    var resN = m.nmDisp || m.nm || fb.res || '';
    var cityN = m.city || fb.city || '';
    var cuis  = m.cuisine || fb.cuisine || '';
    var kam   = amE || tlE || '';
    var zh    = tlE || '';
    var lead = { id:id, name:resN, city:cityN, kam:kam, cuisine:cuis, cmVal:cur, lmVal:prev };

    bump('overall', 'All outlets', grade, lead);
    bump('city',    cityN,  grade, lead);
    bump('cuisine', cuis,   grade, lead);
    bump('zh',      zh ? zh.split('@')[0] : '', grade, lead);
    bump('kam',     kam ? kam.split('@')[0] : '', grade, lead);
  }

  function toArr(obj){
    return Object.keys(obj).map(function(k){ return obj[k]; })
      .sort(function(a,b){ return (b.red*3+b.yellow) - (a.red*3+a.yellow); });
  }
  return {
    status:'OK', period:period, isAdmin:!!context.isAdmin,
    overall: toArr(dims.overall), city: toArr(dims.city), cuisine: toArr(dims.cuisine),
    zh: toArr(dims.zh), kam: toArr(dims.kam)
  };
}

function getOtherAccountsDeficit(period, accountType, viewer) {
  setViewer_(viewer);
  var context = getUserContext();
  if (!context.isAdmin) return { status: 'FORBIDDEN', rows: [] };
  if (['week','month','quarter'].indexOf(period) === -1) period = 'quarter';
  var at = String(accountType || 'CKA').toUpperCase();

  var file = readPeriodFile(period);
  if (!file) return { status: 'NO_FILE', rows: [] };
  var rows = parseData(file.csv);
  rows = scopeRowsForPeriod(rows, period, file.fileDate ? new Date(file.fileDate) : new Date());

  var out = [];
  rows.forEach(function(r){
    var acct = String(r.account || '').toUpperCase();
    if (acct.indexOf(at) === -1) return;   // match CKA / NKA
    var novGap = (r.rawNovTarget||0) - (r.novActual||0);
    var cmGap  = (r.rawCmTarget||0)  - (r.cmActual||0);
    var totalGap = (novGap>0?novGap:0) + (cmGap>0?cmGap:0);
    if (totalGap <= 0) return;
    out.push({
      resId: r.resId||'', res: r.restaurant||'', city: r.city||'',
      am: (r.am||'').split('@')[0], tl: (r.tl||'').split('@')[0],
      novTarget: r.rawNovTarget||0, novActual: r.novActual||0, novGap: novGap,
      cmTarget: r.rawCmTarget||0, cmActual: r.cmActual||0, cmGap: cmGap,
      totalGap: totalGap
    });
  });
  out.sort(function(a,b){ return b.totalGap - a.totalGap; });
  return { status:'OK', period:period, accountType:at, rows: out.slice(0, 25) };
}


// Filter the ticker "misses" to the caller (admins see all).
function scopeMisses_(misses, context) {
  if (!misses) return [];
  if (context.isAdmin) return misses;
  var me = String(context.email || '').toLowerCase();
  return misses.filter(function(m){ return (m.am && m.am === me) || (m.tl && m.tl === me); });
}

function computeAllPeriods_(context) {
  var result = { context: context, status: "OK", generatedAt: null, periods: {} };
  var anyFound = false;

  result.metrics = {};   // per-period res_id -> metrics map (no quarter metrics)
  ['day','week','month','quarter'].forEach(function(p){
    var file = readPeriodFile(p);
    if (!file) { result.periods[p] = null; return; }
    anyFound = true;
    if (!result.generatedAt) result.generatedAt = file.fileDate;
    var refDate = new Date(file.fileDate);
    var rows = scopeRowsForPeriod(parseData(file.csv), p, refDate);
    rows = enrichRowsFromAmtl_(rows);
    rows = filterRowsByRole(rows, context);
    result.periods[p] = rows;

    // supply metrics for this period (the cluster table; matched by res_id)
    var mfile = readMetricFile(p);
    if (mfile) result.metrics[p] = parseMetrics(mfile.csv);
  });

  if (!anyFound) result.status = "BUILDING";

  // Today's Target (T-0): the latest date in the DAY file carries target-only
  // rows for today. Sum its NOV & CM targets (role-filtered) for the small
  // "Today's Target" box on the Targets tab.
  try {
    var dfile = readPeriodFile('day');
    if (dfile) {
      var allDay = filterRowsByRole(parseData(dfile.csv), context);
      var dts = {};
      allDay.forEach(function(r){ var d = parsePeriodLabelToDate(r.period_label); if (d) dts[d.getTime()] = 1; });
      var dk = Object.keys(dts).map(Number).sort(function(a,b){ return a-b; });
      var todayNovT = 0, todayCmT = 0;
      if (dk.length) {
        var t0 = dk[dk.length - 1];   // latest date = today (T-0)
        allDay.forEach(function(r){
          var d = parsePeriodLabelToDate(r.period_label);
          if (d && d.getTime() === t0) { todayNovT += r.rawNovTarget; todayCmT += r.rawCmTarget; }
        });
      }
      result.todayTarget = { novTarget: todayNovT, cmTarget: todayCmT };
    } else {
      result.todayTarget = { novTarget: 0, cmTarget: 0 };
    }
  } catch (e) { result.todayTarget = { novTarget: 0, cmTarget: 0 }; }
  try {
    var LB_TLS = {
      'imaad.khan@zomato.com': 1,
      'abhinav.lohiya@zomato.com': 1
    };

    // ----- Leaderboard: QTD (quarter file), City accounts under the 3 TLs -----
    var qFile = readPeriodFile('quarter');
    var byKam = {};
    var byTl = {};
    if (qFile) {
      var qRows = parseData(qFile.csv);
      for (var qi = 0; qi < qRows.length; qi++) {
        var qr = qRows[qi];
        if (String(qr.account || '').toLowerCase().trim() !== 'city accounts') continue;
        var qtl = String(qr.tl || '').toLowerCase().trim();
        if (!LB_TLS[qtl]) continue;
        var qkam = (qr.am && qr.am !== 'n/a') ? qr.am : qr.tl;
        if (!qkam || qkam === 'n/a') continue;
        if (!byKam[qkam]) byKam[qkam] = { novT:0, novA:0, cmT:0, cmA:0 };
        byKam[qkam].novT += qr.rawNovTarget; byKam[qkam].novA += qr.novActual;
        byKam[qkam].cmT  += qr.rawCmTarget;  byKam[qkam].cmA  += qr.cmActual;
        if (!byTl[qtl]) byTl[qtl] = { novT:0, novA:0, cmT:0, cmA:0 };
        byTl[qtl].novT += qr.rawNovTarget; byTl[qtl].novA += qr.novActual;
        byTl[qtl].cmT  += qr.rawCmTarget;  byTl[qtl].cmA  += qr.cmActual;
      }
    }

    // ----- Ticker (Target Gaps): DAY file, restaurants that missed NOV today --
    // Scoped to the caller: KAM sees own outlets, TL sees team, admin sees all.
    var misses = [];
    var dayFile = readPeriodFile('day');
    if (dayFile) {
      var dayRows = enrichRowsFromAmtl_(scopeRowsForPeriod(parseData(dayFile.csv), 'day', new Date(dayFile.fileDate)));
      for (var i = 0; i < dayRows.length; i++) {
        var r = dayRows[i];
        // Any restaurant that missed its NOV target counts as a deficit.
        if (r.rawNovTarget > 0 && r.novActual < r.rawNovTarget) {
          var kam2 = (r.am && r.am !== 'n/a') ? r.am : r.tl;
          misses.push({
            res: r.restaurant, resId: r.resId || '', city: r.city, kam: (kam2||'').split('@')[0],
            am: String(r.am || '').toLowerCase(), tl: String(r.tl || '').toLowerCase(),
            target: r.rawNovTarget, actual: r.novActual,
            gap: r.rawNovTarget - r.novActual,
            pct: (r.novActual / r.rawNovTarget * 100)
          });
        }
      }
    }

    var mkBoard = function(map){
      var arr = [];
      Object.keys(map).forEach(function(k){
        var b = map[k];
        arr.push({
          name: k.split('@')[0],
          email: k,
          novPct: b.novT > 0 ? (b.novA / b.novT * 100) : 0,
          cmPct:  b.cmT  > 0 ? (b.cmA  / b.cmT  * 100) : 0
        });
      });
      arr.sort(function(a,b){ return b.novPct - a.novPct; });
      return arr;
    };
    result.leaderboard = mkBoard(byKam);     // KAM view (QTD)
    result.leaderboardTl = mkBoard(byTl);    // ZH (TL) view (QTD)

    misses.sort(function(a,b){ return b.gap - a.gap; });
    result.tickerMisses = misses;
    result.tickerMissesAll = misses;   // unscoped copy for per-caller scoping
  } catch (e) {
    result.leaderboard = result.leaderboard || [];
    result.leaderboardTl = result.leaderboardTl || [];
    result.tickerMisses = result.tickerMisses || [];
  }



  return result;
}

// First call on load.
function getInitialData(viewer) {
  setViewer_(viewer);
  return getPeriodData('quarter');
}

// =========================================================
// DAILY EMAIL DIGEST
// Sends a clean HTML summary (Day T-1 + QTD, NOV & Supply CM) to leadership.
// Set up a time-driven trigger on sendDailyDigest() at ~10 AM.
// =========================================================
var DIGEST_TO = 'sachin.bajaj@zomato.com,arvind.palaniappan@zomato.com,jestin.peringelil@zomato.com';  // ROM recipients
var DASHBOARD_URL = 'https://script.google.com/a/macros/zomato.com/s/AKfycbyFuR_7ocv55l5Exk8sZqSVQoX-OvNDzISsJ9MvGH0/exec';  // ROM dashboard
var CLUSTER_LABEL = 'ROM';                           // BHMH build overrides to 'Bharat-MH'

function fmtIN_(n) {
  n = Math.round(n || 0);
  return n.toLocaleString('en-IN');
}

// Sum NOV/CM target+actual for a set of rows.
function sumTA_(rows) {
  var o = { novT:0, novA:0, cmT:0, cmA:0 };
  (rows || []).forEach(function(r){
    o.novT += r.rawNovTarget; o.novA += r.novActual;
    o.cmT  += r.rawCmTarget;  o.cmA  += r.cmActual;
  });
  return o;
}

function buildDigestData_() {
  // Day (T-1): day file scoped (already drops T-0), whole cluster (no role filter).
  var dayFile = readPeriodFile('day');
  var day = dayFile ? sumTA_(scopeRowsForPeriod(parseData(dayFile.csv), 'day', new Date(dayFile.fileDate))) : {novT:0,novA:0,cmT:0,cmA:0};
  // QTD: quarter file, whole cluster.
  var qFile = readPeriodFile('quarter');
  var qtd = qFile ? sumTA_(parseData(qFile.csv)) : {novT:0,novA:0,cmT:0,cmA:0};
  var gen = dayFile ? dayFile.fileDate : (qFile ? qFile.fileDate : new Date().toISOString());
  return { day: day, qtd: qtd, generatedAt: gen };
}

function digestBlock_(title, d) {
  var novPct = d.novT > 0 ? (d.novA / d.novT * 100) : 0;
  var cmPct  = d.cmT  > 0 ? (d.cmA  / d.cmT  * 100) : 0;
  var pctColor = function(p){ return p >= 100 ? '#059669' : (p >= 80 ? '#D97706' : '#DC2626'); };
  var metric = function(label, tgt, act, pct){
    var col = pctColor(pct);
    return '' +
    '<td width="50%" style="padding:8px;">' +
      '<div style="border:1px solid #ECECEF; border-radius:12px; padding:14px 16px; font-family:Arial,sans-serif;">' +
        '<div style="font-size:11px; font-weight:bold; letter-spacing:0.5px; color:#6B7280; text-transform:uppercase;">' + label + '</div>' +
        '<div style="font-size:26px; font-weight:800; color:' + col + '; margin:4px 0; letter-spacing:-0.5px;">' + pct.toFixed(1) + '%</div>' +
        '<div style="font-size:12px; color:#4B5563;">' + fmtIN_(act) + ' <span style="color:#9CA3AF;">/</span> ' + fmtIN_(tgt) + '</div>' +
      '</div>' +
    '</td>';
  };
  return '' +
  '<div style="font-size:13px; font-weight:800; color:#111; margin:18px 0 4px; font-family:Arial,sans-serif;">' + title + '</div>' +
  '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>' +
    metric('NOV Achievement', d.novT, d.novA, novPct) +
    metric('Supply CM Achievement', d.cmT, d.cmA, cmPct) +
  '</tr></table>';
}

function buildDigestHtml_() {
  var data = buildDigestData_();
  var dateStr;
  try { dateStr = Utilities.formatDate(new Date(data.generatedAt), Session.getScriptTimeZone(), 'EEE, dd MMM yyyy'); }
  catch (e) { dateStr = new Date().toDateString(); }

  var linkBtn = (DASHBOARD_URL && DASHBOARD_URL.indexOf('http') === 0)
    ? '<a href="' + DASHBOARD_URL + '" style="display:inline-block; background:#E23744; color:#fff; text-decoration:none; font-weight:bold; font-size:13px; padding:12px 22px; border-radius:10px; font-family:Arial,sans-serif;">Open Full Dashboard &rarr;</a>'
    : '';

  return '' +
  '<div style="max-width:640px; margin:0 auto; background:#F7F8FA; padding:24px; font-family:Arial,sans-serif;">' +
    '<div style="background:#fff; border-radius:18px; padding:22px; box-shadow:0 4px 20px rgba(17,24,39,0.06);">' +
      '<table width="100%"><tr>' +
        '<td><div style="font-size:20px; font-weight:800; color:#111;">Brahmastra</div>' +
        '<div style="font-size:12px; color:#6B7280; font-weight:600;">' + CLUSTER_LABEL + ' &middot; Daily Summary</div></td>' +
        '<td align="right" style="font-size:12px; color:#9CA3AF;">' + dateStr + '</td>' +
      '</tr></table>' +
      '<div style="height:1px; background:#F1F2F4; margin:14px 0;"></div>' +
      digestBlock_('Day (T-1) &mdash; Yesterday', data.day) +
      digestBlock_('QTD &mdash; Quarter to Date', data.qtd) +
      '<div style="margin-top:22px; text-align:center;">' + linkBtn + '</div>' +
      '<div style="margin-top:18px; font-size:11px; color:#9CA3AF; text-align:center;">Auto-sent every morning &middot; numbers as of the latest data drop.</div>' +
    '</div>' +
  '</div>';
}

// Trigger this daily (~10 AM) via a time-driven trigger.
function sendDailyDigest() {
  var html = buildDigestHtml_();
  var subject = 'Brahmastra (' + CLUSTER_LABEL + ') — Daily Summary';
  MailApp.sendEmail({
    to: DIGEST_TO,
    subject: subject,
    htmlBody: html
  });
}

// =========================================================
// SMART DAILY SEND — only when TODAY's files have actually landed.
// Set an HOURLY time-driven trigger on digestWatcher(). It runs 9-11 AM,
// checks that today's day/week/month/quarter files exist, and sends the
// digest at most once per day (guarded by a stored "last sent" date).
// =========================================================

// True if the NOV file for this period exists in the viewer's cluster folder.
function todaysFileExists_(period) {
  try {
    return !!readViewerBase_(NOV_FILE[period]);
  } catch (e) { return false; }
}

function allTodaysFilesReady_() {
  return todaysFileExists_('day') &&
         todaysFileExists_('week') &&
         todaysFileExists_('month') &&
         todaysFileExists_('quarter');
}

function digestWatcher() {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var hour = Number(Utilities.formatDate(now, tz, 'H'));   // 0-23
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // only act in the 9-11 AM window
  if (hour < 9 || hour > 11) return;

  var props = PropertiesService.getScriptProperties();
  var lastSent = props.getProperty('DIGEST_LAST_SENT');
  if (lastSent === today) return;            // already sent today

  if (!allTodaysFilesReady_()) return;       // files not dropped yet — wait for next hour

  sendDailyDigest();
  props.setProperty('DIGEST_LAST_SENT', today);
}

// Handy: run once to preview the digest in your own inbox right now.
function sendDigestTestToMe() {
  var html = buildDigestHtml_();
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: 'TEST — Brahmastra (' + CLUSTER_LABEL + ') Daily Summary',
    htmlBody: html
  });
}

// Handy: reset the "already sent today" guard (e.g. to re-test the watcher).
function resetDigestGuard() {
  PropertiesService.getScriptProperties().deleteProperty('DIGEST_LAST_SENT');
}

// Q2 closed quarter — retired. Returns empty so any stale caller is harmless.
function getQ2Data(viewer) {
  setViewer_(viewer);
  return { context: getUserContext(), status: "OK", rows: [] };
}

// =========================================================
// LAST 2 YEARS  (permanent file, actuals only, no targets)
// Returns slim monthly rows: { period, year, month(0-11), city, tl, am,
// novA, cmA }. Growth (YoY/QoQ/MoM) is computed on the client.
// =========================================================
var MON3_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseYears2_(csvStr) {
  var out = [];
  if (!csvStr) return out;
  var lines = csvStr.replace(/\r/g,'').split('\n');
  if (lines.length < 2) return out;
  var delim = detectDelim(lines[0]);
  var H = splitLine(lines[0], delim).map(function(h){ return h.replace(/"/g,'').toLowerCase().trim(); });
  var idx = {}; for (var i=0;i<H.length;i++) idx[H[i]] = i;
  var col = function(v,n){ var k = idx[n]; return k===undefined ? "" : (v[k]||""); };

  for (var r=1;r<lines.length;r++){
    if (!lines[r]) continue;
    var v = splitLine(lines[r], delim);
    for (var c=0;c<v.length;c++){ var pv=v[c]; if(pv&&pv.charAt(0)==='"'&&pv.charAt(pv.length-1)==='"') v[c]=pv.slice(1,-1).replace(/""/g,'"'); }

    // date can be in "date_day" (YYYY-MM-DD) or "period_label" (DD-Mon-YYYY / Mon-YYYY)
    var rawDate = String(col(v,'date_day') || col(v,'period_label')).trim();
    if (!rawDate) continue;

    var day = 0, mon, yr;
    // ISO: YYYY-MM-DD
    var iso = rawDate.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (iso) {
      yr = parseInt(iso[1],10); mon = parseInt(iso[2],10)-1; day = parseInt(iso[3],10);
    } else {
      // DD-Mon-YYYY
      var dm = rawDate.match(/(\d{1,2})[-\/ ]([A-Za-z]{3,})[-\/ ](\d{4})/);
      if (dm) {
        day = parseInt(dm[1],10); mon = MON3_MAP[dm[2].toLowerCase().slice(0,3)]; yr = parseInt(dm[3],10);
      } else {
        // Mon-YYYY
        var mm = rawDate.match(/([A-Za-z]{3,})[-\/ ](\d{4})/);
        if (!mm) continue;
        mon = MON3_MAP[mm[1].toLowerCase().slice(0,3)]; yr = parseInt(mm[2],10); day = 1;
      }
    }
    if (mon === undefined || isNaN(yr) || isNaN(mon)) continue;

    out.push({
      period: rawDate, year: yr, month: mon, day: day,
      ymd: yr*10000 + (mon+1)*100 + day,
      city: col(v,'city_name') || 'Unknown',
      tl: String(col(v,'tl_email')||'n/a').toLowerCase(),
      am: String(col(v,'am_email')||'n/a').toLowerCase(),
      novA: parseNumG(col(v,'nov_actual')),
      // new file uses "Supply_cm"; old used "supply_cm_actual"
      cmA:  parseNumG(col(v,'supply_cm') || col(v,'supply_cm_actual'))
    });
  }
  return out;
}

// YoY Growth — period-aware (Day T-1 / WTD / MTD / QTD):
//   TY (this year) target+actual  -> from the live period file (day/week/month/quarter)
//   LY (last year) actual          -> from the permanent DAY-WISE years2 file (JAS 2025),
//                                      matched to the SAME quarter-day-count as this year.
//
// "Same quarter-day-count": the current JAS quarter starts 1-Jul. If today is T-1 = 6-Jul,
// then 6 days of the quarter have elapsed. We take the LY quarter's first 6 days for QTD,
// the corresponding month-to-date / week-to-date / that single day for the others.
var JAS_START = { m: 6, d: 1 };   // 1 July (month index 6)

function jasDayCount_(refDate) {
  // days elapsed in the JAS quarter up to and including refDate
  var y = refDate.getFullYear();
  var start = new Date(y, JAS_START.m, JAS_START.d);
  var diff = Math.floor((refDate - start) / 86400000) + 1;
  return diff < 1 ? 1 : diff;
}

function getYears2Data(period, viewer) {
  // YoY (last-2-years) view retired.
  setViewer_(viewer);
  return { context: getUserContext(), status: "OK", rows: [], period: period, periodLabel: '', refDate: null, qDays: 1 };
}

// =========================================================
// ONLINE PRESENCE  (uses ScriptProperties - no Drive writes)
// =========================================================
const PRESENCE_PROP = 'ONLINE_USERS';
const PRESENCE_WINDOW_MS = 90 * 1000;

function trackPresence(email) {
  if (!email) return;
  try {
    const props = PropertiesService.getScriptProperties();
    let map = {};
    const raw = props.getProperty(PRESENCE_PROP);
    if (raw) { try { map = JSON.parse(raw); } catch (e) { map = {}; } }
    const now = Date.now();
    map[email] = now;
    Object.keys(map).forEach(function(k) { if (now - map[k] > PRESENCE_WINDOW_MS) delete map[k]; });
    props.setProperty(PRESENCE_PROP, JSON.stringify(map));
  } catch (e) { /* never break the app for presence */ }
}

function heartbeatPresence() {
  const context = getUserContext();
  trackPresence(context.email);
  if (!context.isAdmin) return { isAdmin: false, count: 0, users: [] };
  try {
    const props = PropertiesService.getScriptProperties();
    let map = {};
    const raw = props.getProperty(PRESENCE_PROP);
    if (raw) { try { map = JSON.parse(raw); } catch (e) { map = {}; } }
    const now = Date.now();
    const users = [];
    Object.keys(map).forEach(function(k) {
      if (now - map[k] <= PRESENCE_WINDOW_MS) {
        users.push({ email: k, name: k.split('@')[0], secondsAgo: Math.round((now - map[k]) / 1000) });
      }
    });
    users.sort(function(a, b) { return a.secondsAgo - b.secondsAgo; });
    return { isAdmin: true, count: users.length, users: users };
  } catch (e) {
    return { isAdmin: true, count: 0, users: [] };
  }
}

// =========================================================
// DEBUG - run manually to verify the four files are found & parsed.
// =========================================================
function debugPeriodFiles() {
  var ctx = getUserContext();
  Logger.log('Context: ' + JSON.stringify(ctx));
  ['day','week','month','quarter'].forEach(function(p){
    var f = readPeriodFile(p);
    if (!f) { Logger.log(p + ' -> ' + NOV_FILE[p] + '_<cluster>_DD_MM.csv -> NOT FOUND'); return; }
    var rows = parseData(f.csv);
    var mine = filterRowsByRole(rows, ctx);
    Logger.log(p + ' -> ' + f.name + ' | parsed ' + rows.length + ' rows | after role filter ' + mine.length);
  });
}

// =========================================================
// LEAD-LIST DOWNLOAD COOLDOWN
// Day (T-1): once per day · WTD: once per week · MTD: once every 5 days.
// Keyed by email + period + scope so an admin can still run each KAM / the
// whole cluster once per window. Stored in ScriptProperties (per-cluster).
// =========================================================
const LEAD_COOLDOWN_PROP = 'LEADLIST_COOLDOWN';
const LEAD_COOLDOWN_MSG  = 'A lead list has already been generated for this period. Please use your previously generated lead list.';

function leadCooldownAll_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(LEAD_COOLDOWN_PROP);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function leadCooldownSave_(map) {
  try { PropertiesService.getScriptProperties().setProperty(LEAD_COOLDOWN_PROP, JSON.stringify(map)); } catch (e) {}
}
function leadScopeKey_(scope, kam) {
  if (scope === 'kam' && kam) return 'kam:' + String(kam).toLowerCase().trim();
  if (scope === 'cluster')   return 'cluster';
  return 'mine';
}
function leadCoolKey_(email, period, scope, kam) {
  return String(email || '').toLowerCase() + '::' + period + '::' + leadScopeKey_(scope, kam);
}
// same calendar day (script timezone)
function sameDayTz_(a, b) {
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(a), tz, 'yyyy-MM-dd') === Utilities.formatDate(new Date(b), tz, 'yyyy-MM-dd');
}
// same ISO week (script timezone)
function sameIsoWeekTz_(a, b) {
  var tz = Session.getScriptTimeZone();
  var la = Utilities.formatDate(new Date(a), tz, 'yyyy-MM-dd').split('-');
  var lb = Utilities.formatDate(new Date(b), tz, 'yyyy-MM-dd').split('-');
  var da = new Date(+la[0], +la[1] - 1, +la[2]);
  var db = new Date(+lb[0], +lb[1] - 1, +lb[2]);
  return isoWeekLabel(da) === isoWeekLabel(db);
}
// Returns { blocked:bool, message, prev:{url,name,ts} }.
function leadCooldownCheck_(email, period, scope, kam) {
  var rec = leadCooldownAll_()[leadCoolKey_(email, period, scope, kam)];
  if (!rec || !rec.ts) return { blocked: false };
  var now = Date.now(), last = Number(rec.ts) || 0;
  var blocked = false;
  if (period === 'day')        blocked = sameDayTz_(now, last);
  else if (period === 'week')  blocked = sameIsoWeekTz_(now, last);
  else if (period === 'month') blocked = (now - last) < (5 * 24 * 60 * 60 * 1000);
  return blocked
    ? { blocked: true, message: LEAD_COOLDOWN_MSG, prev: { url: rec.url || '', name: rec.name || '', ts: last } }
    : { blocked: false };
}
function leadCooldownRecord_(email, period, scope, kam, url, name) {
  var map = leadCooldownAll_();
  map[leadCoolKey_(email, period, scope, kam)] = { ts: Date.now(), url: url || '', name: name || '' };
  // prune entries older than 45 days to keep the property small
  var cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  Object.keys(map).forEach(function(k){ if ((Number(map[k].ts) || 0) < cutoff) delete map[k]; });
  leadCooldownSave_(map);
}

// Card/overall lead lists are one working sheet per metric and scope every
// five days. A repeat request returns the same tracker instead of creating
// duplicate sheets and duplicate Ongoing Drive cards.
const METRIC_LEAD_COOLDOWN_PROP = 'METRIC_LEADLIST_5_DAY';
function metricLeadCooldownAll_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(METRIC_LEAD_COOLDOWN_PROP);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function metricLeadCooldownSave_(map) {
  try { PropertiesService.getScriptProperties().setProperty(METRIC_LEAD_COOLDOWN_PROP, JSON.stringify(map || {})); } catch(e) {}
}
function metricLeadKey_(email, cluster, metric, scope) {
  return [String(email||'').toLowerCase().trim(), clusterKey_(cluster||''), String(metric||'').toLowerCase(), String(scope||'all').toLowerCase()].join('::');
}
function metricLeadCooldownCheck_(email, cluster, metric, scope) {
  var rec = metricLeadCooldownAll_()[metricLeadKey_(email, cluster, metric, scope)];
  if (!rec || !rec.ts || (Date.now() - Number(rec.ts)) >= 5 * 24 * 60 * 60 * 1000) return { blocked:false };
  return { blocked:true, url:rec.url || '', count:rec.count || 0, label:rec.label || '', message:'This lead list was already created in the last 5 days. Opening the same sheet.' };
}
function metricLeadCooldownRecord_(email, cluster, metric, scope, url, count, label) {
  var map = metricLeadCooldownAll_();
  map[metricLeadKey_(email, cluster, metric, scope)] = { ts:Date.now(), url:url||'', count:count||0, label:label||'' };
  var cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  Object.keys(map).forEach(function(k){ if ((Number(map[k].ts)||0) < cutoff) delete map[k]; });
  metricLeadCooldownSave_(map);
}
function metricLeadCooldownRemoveByUrl_(url) {
  url = String(url || '').trim();
  if (!url) return false;
  var map = metricLeadCooldownAll_(), changed = false;
  Object.keys(map).forEach(function(k){
    if (String((map[k] && map[k].url) || '').trim() === url) { delete map[k]; changed = true; }
  });
  if (changed) metricLeadCooldownSave_(map);
  return changed;
}
function hasRegisteredLeadDriveUrl_(url) {
  url = String(url || '').trim();
  return !!url && drivesAll_().some(function(d){ return String(d.url || '').trim() === url; });
}

// One-time/manual repair for lists removed before the unified delete lifecycle
// existed. Run this from the Apps Script editor, then refresh the dashboard.
// It deletes only cooldown entries whose URL no longer has an Ongoing Drive;
// active/generated lists remain untouched.
function cleanupOrphanLeadListCooldowns() {
  var registered = {};
  drivesAll_().forEach(function(d){
    var url = String(d.url || '').trim();
    if (url) registered[url] = true;
  });
  var map = metricLeadCooldownAll_(), removed = [], kept = 0;
  Object.keys(map).forEach(function(key){
    var url = String((map[key] && map[key].url) || '').trim();
    if (url && !registered[url]) { removed.push({ key:key, url:url, label:map[key].label || '' }); delete map[key]; }
    else kept++;
  });
  metricLeadCooldownSave_(map);
  Logger.log('Removed orphan lead-list cooldowns: ' + JSON.stringify(removed));
  return { status:'OK', removed:removed.length, kept:kept, records:removed };
}

// =========================================================
// ONGOING DRIVES  +  NOTIFICATIONS
// Stored in ScriptProperties (per-cluster; ROM/BHMH are separate projects).
// Creating a drive broadcasts a notification to every user. Admins can also
// send custom / reminder notifications and see who has viewed each one.
// =========================================================
const DRIVES_PROP      = 'DRIVES';
const NOTIF_PROP       = 'NOTIFICATIONS';
const NOTIF_VIEWS_PROP = 'NOTIF_VIEWS';
const NOTIF_STORE_FOLDER_NAME = 'Brahmastra_Notification_Store';
const DRIVES_STORE_FILE_NAME = 'ongoing_drives.json';
const NOTIF_STORE_FILE_NAME = 'notifications.json';
const NOTIF_VIEWS_FILE_NAME = 'notification_views.json';
const NOTIF_USER_LOOKBACK_DAYS = 3;

function drivesAll_() {
  // Drive cards can easily exceed the per-value Script Properties quota.
  // Keep the canonical registry in Drive JSON, just like notifications, and
  // migrate the legacy property automatically on first read.
  var store = notifDriveJson_(DRIVES_STORE_FILE_NAME, []);
  if (store.available && !store.empty) return Array.isArray(store.value) ? store.value : [];
  var legacy = [];
  try { var raw = PropertiesService.getScriptProperties().getProperty(DRIVES_PROP); legacy = raw ? JSON.parse(raw) : []; } catch (e) {}
  if (!Array.isArray(legacy)) legacy = [];
  if (store.available) notifDriveJsonSave_(DRIVES_STORE_FILE_NAME, legacy);
  return legacy;
}
function drivesSave_(list) {
  list = Array.isArray(list) ? list : [];
  if (notifDriveJsonSave_(DRIVES_STORE_FILE_NAME, list)) return true;
  try { PropertiesService.getScriptProperties().setProperty(DRIVES_PROP, JSON.stringify(list)); return true; } catch (e) {}
  return false;
}

function leadDriveKam_(row) {
  return String((row && (row.kam || row.kam_email || row.am_email || row.am)) || '').trim().toLowerCase();
}
function leadDrivePersonName_(email) {
  var local = String(email || '').trim().toLowerCase().split('@')[0];
  return local.split(/[._-]+/).filter(function(x){ return !!x; }).map(function(x){
    return x.charAt(0).toUpperCase() + x.slice(1);
  }).join(' ') || 'Team member';
}
function leadDriveRoleLabel_(role) {
  return ({ super:'Super Core', ceo:'Cluster CEO', zh:'ZH/TL', kam:'KAM' })[String(role || '').toLowerCase()] || 'Team member';
}

// Lead-list visibility follows the operating hierarchy. A KAM's list is also
// visible to their ZH, a ZH's list to their mapped KAMs and CEO, and a CEO's
// list to the whole cluster. Case counts/progress remain personalised later.
function selfMadeRecipients_(rv, creatorEmail) {
  var creator = String(creatorEmail || '').trim().toLowerCase();
  var rows = loadMaster_().filter(function(r){ return clusterKey_(r.city_cluster) === clusterKey_(rv.cluster); });
  var clusterKams = uniq_(rows.map(function(r){ return String(r.kam_email||'').trim().toLowerCase(); }));
  var clusterZhs = uniq_(rows.map(function(r){ return String(r.zh_email||'').trim().toLowerCase(); }));
  if (rv.role === 'kam') {
    var ownerZhs = uniq_(rows.filter(function(r){ return String(r.kam_email||'').trim().toLowerCase() === creator; })
      .map(function(r){ return String(r.zh_email||'').trim().toLowerCase(); }));
    return { kams:[creator], zhs:ownerZhs };
  }
  if (rv.role === 'zh') return { kams:(rv.kams||[]).map(function(x){ return String(x||'').toLowerCase(); }), zhs:[creator] };
  // Includes CEO and a Super Admin who has opened one concrete cluster.
  return { kams:clusterKams, zhs:clusterZhs };
}

function registerSelfMadeLeadDrive_(opts) {
  // Best-effort only: lead-list generation must still succeed if drive storage
  // is temporarily unavailable.
  try {
    opts = opts || {};
    var rv = opts.rv || {}, creator = String(opts.creator || '').trim().toLowerCase();
    if (!creator || !opts.url) return null;
    // A retry/cooldown callback may ask to register the same workbook again.
    // Return its existing card instead of creating duplicates.
    var existing = drivesAll_().filter(function(d){ return String(d.url||'').trim() === String(opts.url||'').trim(); })[0];
    if (existing) return existing;
    var recipients = selfMadeRecipients_(rv, creator);
    var kamCounts = {}, zhCounts = {}, caseCount = 0;
    (opts.rows || []).forEach(function(row){
      var kam = leadDriveKam_(row);
      if (!kam) return;
      kamCounts[kam] = (kamCounts[kam] || 0) + 1;
      caseCount++;
    });
    // Add zero-case KAMs too: they are still intended recipients of a ZH/CEO
    // drive and must see the orange Self Made card.
    (recipients.kams || []).forEach(function(k){ if (k && kamCounts[k] == null) kamCounts[k] = 0; });
    var masterRows = loadMaster_().filter(function(r){ return clusterKey_(r.city_cluster) === clusterKey_(rv.cluster); });
    masterRows.forEach(function(r){
      var z = String(r.zh_email||'').trim().toLowerCase();
      var k = String(r.kam_email||'').trim().toLowerCase();
      if (z && (recipients.zhs||[]).indexOf(z) !== -1) zhCounts[z] = (zhCounts[z] || 0) + (kamCounts[k] || 0);
    });
    (recipients.zhs || []).forEach(function(z){ if (z && zhCounts[z] == null) zhCounts[z] = 0; });
    var now = new Date();
    var drive = {
      id:'SELF' + now.getTime() + Math.floor(Math.random()*1000),
      name:String(opts.name || 'Lead List'), url:String(opts.url), leadTab:String(opts.leadTab || ''),
      startDate:Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'), endDate:'',
      createdAt:now.toISOString(), createdBy:creator, createdRole:isSuperUser_(creator) ? 'super' : (rv.role || ''),
      cluster:rv.cluster || '', clusterKey:clusterKey_(rv.cluster),
      selfMade:true, driveType:'Self Made', assignedKams:recipients.kams || [], assignedZhs:recipients.zhs || [],
      kamCounts:kamCounts, zhCounts:zhCounts, totalCases:caseCount,
      uniqueKams:Object.keys(kamCounts).filter(function(k){ return kamCounts[k] > 0; }).length,
      uniqueZhs:Object.keys(zhCounts).filter(function(z){ return zhCounts[z] > 0; }).length,
      notifySlots:[], lastRemind:{}
    };
    var list = drivesAll_(); list.unshift(drive);
    if (!drivesSave_(list)) return null;
    return drivesAll_().some(function(d){ return String(d.id)===String(drive.id); }) ? drive : null;
  } catch (e) { return null; }
}

function canSeeSelfMadeDrive_(d, rv, email) {
  email = String(email || '').trim().toLowerCase();
  if (!d || !d.selfMade) return true;     // manually created drives retain existing visibility
  // Fail closed at the cluster boundary.  KAM/ZH emails can occur in more
  // than one hierarchy row, so assignment alone is not enough to stop a
  // lead-list made in Cluster A appearing while that person is viewing
  // Cluster B. Super Core deliberately remains cross-cluster.
  if (rv.role !== 'super') {
    var viewerCluster = clusterKey_(rv.cluster || '');
    var driveCluster = clusterKey_(d.clusterKey || d.cluster || '');
    if (!viewerCluster || !driveCluster || viewerCluster !== driveCluster) return false;
  }
  if (String(d.createdBy||'').toLowerCase() === email) return true;
  if (rv.role === 'super') return true;
  if (rv.role === 'ceo') return true;      // cluster check above has already passed
  if (rv.role === 'kam') return (d.assignedKams || []).indexOf(email) !== -1;
  if (rv.role === 'zh')  return (d.assignedZhs || []).indexOf(email) !== -1;
  return false;                           // no upward / peer visibility
}
function sheetIdFromUrl_(url) {
  var s = String(url || '').trim();
  var m = s.match(/\/d\/([a-zA-Z0-9\-_]+)/);   if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9\-_]+)/);       if (m) return m[1];
  if (/^[a-zA-Z0-9\-_]{20,}$/.test(s)) return s;   // bare ID
  return '';
}
function driveStatus_(d, nowMs) {
  var s = d.startDate ? Date.parse(d.startDate) : 0;
  var e = d.endDate   ? (Date.parse(d.endDate) + 86400000 - 1) : 0;   // inclusive end day
  if (s && nowMs < s) return 'upcoming';
  if (e && nowMs > e) return 'ended';
  return 'active';
}

// Everyone who can open the dashboard can see the drives.
// A1-style column letter -> 0-based index ("A"->0, "C"->2, "AA"->26).
function colLetterToIndex_(letter) {
  letter = String(letter || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letter) return -1;
  var idx = 0;
  for (var i = 0; i < letter.length; i++) idx = idx * 26 + (letter.charCodeAt(i) - 64);
  return idx - 1;
}

// Read a drive's tab and count rows per KAM email (and per ZH email if given).
// When a Cluster column is supplied, retain a second set of counts per cluster
// so a Super Core drive is never shown as one unscoped drive to every cluster.
// Only cells that look like an email are counted, so header rows are skipped.
function driveCountsFromSheet_(ssId, tabName, kamColIdx, zhColIdx, clusterColIdx) {
  var out = { kam: {}, zh: {}, cases: 0, clusterCounts:{}, clusterKamCounts:{}, clusters:{} };
  if (kamColIdx < 0 && zhColIdx < 0) return out;
  var master = loadMaster_();
  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sh = tabName ? ss.getSheetByName(tabName) : ss.getSheets()[0];
    if (!sh) return out;
    var values = sh.getDataRange().getValues();
    for (var r = 0; r < values.length; r++) {
      var row = values[r], counted = false, ke = '', cluster = '', clusterKey = '';
      if (kamColIdx >= 0 && kamColIdx < row.length) {
        ke = String(row[kamColIdx] || '').toLowerCase().trim();
        if (ke.indexOf('@') !== -1) { out.kam[ke] = (out.kam[ke] || 0) + 1; counted = true; }
      }
      if (zhColIdx >= 0 && zhColIdx < row.length) {
        var ze = String(row[zhColIdx] || '').toLowerCase().trim();
        if (ze.indexOf('@') !== -1) { out.zh[ze] = (out.zh[ze] || 0) + 1; }
      }
      if (clusterColIdx >= 0 && clusterColIdx < row.length) {
        cluster = String(row[clusterColIdx] || '').trim();
        if (cluster) {
          var matches = master.filter(function(m){ return m.city_cluster === cluster || clusterKey_(m.city_cluster) === clusterKey_(cluster); });
          cluster = matches.length ? matches[0].city_cluster : cluster;
          clusterKey = clusterKey_(cluster);
          out.clusters[clusterKey] = cluster;
        }
      }
      if (counted) {
        out.cases++;
        if (clusterKey) {
          out.clusterCounts[clusterKey] = (out.clusterCounts[clusterKey] || 0) + 1;
          if (ke && ke.indexOf('@') !== -1) {
            if (!out.clusterKamCounts[clusterKey]) out.clusterKamCounts[clusterKey] = {};
            out.clusterKamCounts[clusterKey][ke] = (out.clusterKamCounts[clusterKey][ke] || 0) + 1;
          }
        }
      }
    }
  } catch (e) {}
  return out;
}

function driveMatchesCluster_(d, rv) {
  if (!d || !rv) return false;
  if (rv.role === 'super') return true;
  var key = clusterKey_(rv.cluster || '');
  if (!key) return false;
  if (d.clusterCounts && Object.keys(d.clusterCounts).length) return !!d.clusterCounts[key];
  // Older/non-Super drives without a source cluster column are visible only
  // when they were explicitly created in this one cluster.
  return !!d.clusterKey && d.clusterKey === key;
}

// A drive is useful to a field owner only when it contains at least one case
// in that owner's hierarchy.  This is intentionally evaluated from the saved
// allocation snapshot, so zero-case drives never appear merely because they
// belong to the same cluster.
function driveHasViewerCases_(d, rv, email) {
  if (!d || !rv) return false;
  email = String(email || '').trim().toLowerCase();
  if (rv.role === 'super') return Number(d.totalCases || 0) > 0;
  if (rv.role === 'ceo') return Number(d.totalCases || 0) > 0;
  if (rv.role === 'kam') return Number((d.kamCounts || {})[email] || 0) > 0;
  if (rv.role === 'zh' || rv.role === 'tl') {
    if (Number((d.zhCounts || {})[email] || 0) > 0) return true;
    return (rv.kams || []).some(function(k){ return Number((d.kamCounts || {})[String(k||'').toLowerCase()] || 0) > 0; });
  }
  return false;
}

function scopeDriveToCluster_(d, rv) {
  var out = {}, k;
  for (k in d) out[k] = d[k];
  if (!rv || rv.role === 'super') return out;
  var key = clusterKey_(rv.cluster || '');
  if (d.clusterCounts && Object.keys(d.clusterCounts).length) {
    out.totalCases = d.clusterCounts[key] || 0;
    out.kamCounts = (d.clusterKamCounts && d.clusterKamCounts[key]) || {};
    out.uniqueKams = Object.keys(out.kamCounts).length;
    var zhCounts = {}, master = loadMaster_();
    master.forEach(function(r){
      if (clusterKey_(r.city_cluster) !== key) return;
      var kam = String(r.kam_email||'').toLowerCase(), zh = String(r.zh_email||'').toLowerCase();
      if (zh && out.kamCounts[kam] != null) zhCounts[zh] = (zhCounts[zh] || 0) + out.kamCounts[kam];
    });
    out.zhCounts = zhCounts;
    out.uniqueZhs = Object.keys(zhCounts).length;
  }
  return out;
}

// Snapshot a newly-linked drive so old KAM allocations remain available even
// after its source sheet is changed or removed.
function archiveDriveSnapshot_(drive) {
  try {
    var ss = SpreadsheetApp.openById(DRIVE_HISTORY_SHEET_ID);
    var sh = ss.getSheetByName('Drive History') || ss.insertSheet('Drive History');
    if (sh.getLastRow() === 0) sh.appendRow(['Snapshot Time','Drive ID','Drive Name','Drive Type','KAM Email','Assigned Cases','Start Date','End Date','Source Sheet']);
    var rows = Object.keys(drive.kamCounts||{}).sort().map(function(k){
      return [new Date(),drive.id,drive.name,drive.driveType||'',k,drive.kamCounts[k]||0,drive.startDate||'',drive.endDate||'',drive.url||''];
    });
    if (rows.length) sh.getRange(sh.getLastRow()+1,1,rows.length,rows[0].length).setValues(rows);
  } catch (e) { /* archive access must never block creating the drive */ }
}

function getDrives(viewer, clusterOverride, viewAsKam, includeMetrics) {
  setClusterOverride_(clusterOverride || '');
  // Ongoing Drives must use the same preview context as the rest of the
  // dashboard. Without this, a CEO/Core user in "View as KAM" was evaluated
  // as the parent role and could receive another cluster's self-made cards.
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var context = getUserContext();
  var vemail = String(context.email || '').toLowerCase();
  var actualEmail = String(context.actualEmail || viewer || vemail).toLowerCase();
  var rv = resolveViewer_(actualEmail, clusterOverride || '');
  var personalEmail = String(viewAsKam || vemail || '').trim().toLowerCase();
  var personalMaps = personalDriveSheets_();
  var now = Date.now();
  var list = drivesAll_().filter(function(d){
    // Card/overall lead lists are never cross-cluster browsing items. This
    // also protects older lead-list cards created before `selfMade` metadata
    // was introduced: a CEO sees only the current cluster's list, while Super
    // Core retains its all-cluster view.
    var isLeadList = !!d.selfMade || /lead\s*list|\bleads?\b/i.test(String(d.name||''));
    if (rv.role !== 'super' && isLeadList && clusterKey_(d.clusterKey || d.cluster || '') !== clusterKey_(rv.cluster || '')) return false;
    var scoped = scopeDriveToCluster_(d, rv);
    return canSeeSelfMadeDrive_(scoped, rv, vemail) &&
      (!scoped.selfMade ? driveMatchesCluster_(scoped, rv) : true) &&
      driveHasViewerCases_(scoped, rv, vemail);
  }).map(function(d){
    d = scopeDriveToCluster_(d, rv);
    var myCount = 0, myRole = '';
    if (d.selfMade) {
      // Never send a team-wide count to a KAM/ZH: each sees only their own
      // mapped cases, even when the CEO created the lead list.
      if (rv.role === 'kam' && (d.assignedKams || []).indexOf(vemail) !== -1) { myCount = (d.kamCounts && d.kamCounts[vemail]) || 0; myRole = 'KAM'; }
      else if (rv.role === 'zh' && (d.assignedZhs || []).indexOf(vemail) !== -1) { myCount = (d.zhCounts && d.zhCounts[vemail]) || 0; myRole = 'ZH'; }
    } else if (d.kamCounts && d.kamCounts[vemail] != null) { myCount = d.kamCounts[vemail]; myRole = 'KAM'; }
    else if (d.zhCounts && d.zhCounts[vemail] != null) { myCount = d.zhCounts[vemail]; myRole = 'ZH'; }
    else if (rv.role === 'zh') { myCount = (d.zhCounts && d.zhCounts[vemail]) || 0; myRole = 'ZH'; }

    // Sheet reads are optional. The first request returns cards immediately;
    // progress/counts are loaded by a second background request.
    var ach = { pct:null, approached:null, notApproached:null, counts:null };
    if (includeMetrics && !d.selfMade) {
      try { ach = driveScopedTrackerProgress_(d, rv, vemail); } catch (e) {}
    }
    // Self-made lead lists already contain their own Approached / Action Taken
    // and Converted tracker columns. Read those live so each owner can see
    // their actual progress in Ongoing Drives without opening the sheet first.
    var selfProgress = null, selfProgressTabs = null;
    if (includeMetrics && d.selfMade) {
      try {
        selfProgress = selfMadeLeadProgress_(d, rv, vemail);
        // Overall workbooks have one actionable tab per metric.  The Summary
        // tab contains formulas only, so surface live Yes/No progress from
        // each metric tab on the Ongoing Drive card.
        if (/\boverall\s+lead\s+list\b/i.test(String(d.name || ''))) {
          selfProgressTabs = selfMadeLeadProgressTabs_(d, rv, vemail);
        }
      } catch (e) { selfProgress = null; selfProgressTabs = null; }
    } else if (includeMetrics && (rv.role === 'kam' || rv.role === 'zh')) {
      // Central/Cluster drives are also personal trackers for KAM/ZH. Their
      // Yes/No updates deserve the same visible progress line as a lead list.
      selfProgress = ach && ach.total != null ? ach : null;
    }

    // The count printed as "Your cases (KAM)" must use the same denominator
    // as the Yes/No progress bar. For a personal KAM sheet this is the exact
    // copied allocation, not an old drive snapshot.
    if (rv.role === 'kam' && selfProgress && selfProgress.total != null) myCount = selfProgress.total;

    var personal = personalMaps[makePersonalDriveKey_(d.id, personalEmail)] || null;
    return { id:d.id, name:d.name, url:d.url, startDate:d.startDate || '', endDate:d.endDate || '',
             leadTab:d.leadTab || '', createdAt:d.createdAt || '', status: driveStatus_(d, now),
             myCount: myCount, myRole: myRole, notifySlots: d.notifySlots || [],
             totalCases: d.totalCases || 0, uniqueKams: d.uniqueKams || 0, uniqueZhs: d.uniqueZhs || 0,
             driveType: d.driveType || '',           // 'Central' | 'Cluster'
             // Only a real/effective KAM gets a personal working-sheet CTA.
             // View-as-ZH/TL also travels in `viewAsKam`, so testing that raw
             // parameter incorrectly showed "Create My Sheet" to ZH/TL.
             // Their card must keep the scoped source sheet and team status.
             personalSheet: !d.selfMade && rv.role === 'kam',
             personalSheetReady: !!(personal && personal.url), personalSheetUrl: personal && personal.url ? personal.url : '',
             // Team drill-down exists only on a card that is already within
             // this person's active case scope. CEO sees ZH → KAM; TL/ZH
             // sees only their own KAM team.
             canViewKamStatus: (rv.role === 'ceo' || rv.role === 'zh' || rv.role === 'tl') &&
               (rv.role === 'ceo' ? Number(d.totalCases || 0) > 0 : myCount > 0),
             teamStatusScope: rv.role === 'ceo' ? 'ceo' : ((rv.role === 'zh' || rv.role === 'tl') ? 'zh' : ''),
             selfMade: !!d.selfMade, createdRole:d.createdRole || '', creatorRoleLabel:leadDriveRoleLabel_(d.createdRole),
             createdBy:d.createdBy || '', creatorName:leadDrivePersonName_(d.createdBy),
             isCreator:String(d.createdBy||'').toLowerCase() === vemail,
             completed:!!d.completed, completedAt:d.completedAt || '',
             cluster:d.cluster || '', clusters:d.clusters || {},
             canManage: isSuperUser_(actualEmail) || String(d.createdBy||'').toLowerCase() === actualEmail,
             achievedPct: ach.pct, approached: ach.approached,
             notApproached: ach.notApproached, dropdownCounts: ach.counts,
             progressTotal: ach.total, yes: ach.achieved, no: ach.no,
             noPct: ach.noPct, pending: ach.pending,
             // Case counts are already stored on the drive card. Never make
             // the client wait on a Sheet read to show them; detailed tracker
             // progress is filled in later, one card at a time.
             selfProgress:selfProgress, selfProgressTabs:selfProgressTabs, metricsPending:false };
  });
  var rank = { active:0, upcoming:1, ended:2 };
  list.sort(function(a,b){
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return { status:'OK', drives: list };
}

// Second-stage Ongoing Drives load. It runs only after cards are visible.
function getDriveMetrics(viewer, clusterOverride, viewAsKam) {
  var full = getDrives(viewer, clusterOverride, viewAsKam, true);
  return { status:full.status || 'OK', metrics:(full.drives || []).map(function(d){
    return { id:d.id, myCount:d.myCount, myRole:d.myRole, totalCases:d.totalCases,
      uniqueKams:d.uniqueKams, uniqueZhs:d.uniqueZhs, achievedPct:d.achievedPct,
      approached:d.approached, notApproached:d.notApproached,
      dropdownCounts:d.dropdownCounts, progressTotal:d.progressTotal, yes:d.yes,
      no:d.no, noPct:d.noPct, pending:d.pending,
      selfProgress:d.selfProgress, selfProgressTabs:d.selfProgressTabs || null, metricsPending:false };
  }) };
}

// One-card version of the metrics loader. Opening many Google Sheets in one
// Apps Script execution can hit the runtime limit, leaving every card in a
// permanent loading state. The browser calls this sequentially instead, so a
// slow or inaccessible sheet affects only that single card.
function getDriveMetric(id, viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var visible = getDrives(viewer, clusterOverride, viewAsKam, false).drives || [];
  var card = visible.filter(function(d){ return String(d.id) === String(id); })[0];
  if (!card) return { status:'FORBIDDEN', id:id };
  var raw = drivesAll_().filter(function(d){ return String(d.id) === String(id); })[0];
  if (!raw) return { status:'NOT_FOUND', id:id };
  var ctx = getUserContext();
  var actual = String(ctx.actualEmail || viewer || '').toLowerCase();
  var rv = resolveViewer_(actual, clusterOverride || '');
  var vemail = String(ctx.email || viewer || '').toLowerCase();
  var selfProgress = null, selfProgressTabs = null, ach = { pct:null, approached:null, notApproached:null, counts:null };
  try {
    if (raw.selfMade) {
      selfProgress = selfMadeLeadProgress_(raw, rv, vemail);
      if (/\boverall\s+lead\s+list\b/i.test(String(raw.name || ''))) selfProgressTabs = selfMadeLeadProgressTabs_(raw, rv, vemail);
    }
    else {
      ach = driveScopedTrackerProgress_(raw, rv, vemail);
      if (rv.role === 'kam' || rv.role === 'zh') selfProgress = ach && ach.total != null ? ach : null;
    }
  } catch (e) { /* one broken sheet must not break the queue */ }
  // Never leave a card on "Syncing" forever.  If a source is temporarily
  // inaccessible, show the known assignment total at 0% and retry on the next
  // normal card refresh; as soon as the sheet is reachable, live values win.
  if (!raw.selfMade && (!ach || ach.total == null)) {
    var knownTotal = card.myCount || (rv.role === 'zh' ? card.myCount : card.totalCases) || 0;
    ach = { total:knownTotal, achieved:0, achievedPct:0, no:0, noPct:0, pending:knownTotal,
      pct:0, approached:0, notApproached:knownTotal, counts:{}, actionLabel:'Approached' };
    if (rv.role === 'kam' || rv.role === 'zh') selfProgress = ach;
  }
  // Do not let a partial/temporarily stale source read turn an assigned KAM's
  // progress denominator into 0 or 1. The saved allocation is fixed for the
  // drive; any unread rows are pending until their tracker values are read.
  if (!raw.selfMade && rv.role === 'kam' && selfProgress && Number(card.myCount || 0) > Number(selfProgress.total || 0)) {
    var stableTotal = Number(card.myCount || 0);
    selfProgress.total = stableTotal;
    selfProgress.pending = Math.max(0, stableTotal - Number(selfProgress.achieved || 0) - Number(selfProgress.no || 0));
    selfProgress.achievedPct = stableTotal ? Math.round(Number(selfProgress.achieved || 0) / stableTotal * 100) : 0;
    selfProgress.noPct = stableTotal ? Math.round(Number(selfProgress.no || 0) / stableTotal * 100) : 0;
    selfProgress.pct = selfProgress.achievedPct;
    selfProgress.notApproached = selfProgress.pending;
  }
  // The saved allocation is the stable source for "Your cases". A live
  // tracker read can temporarily return zero while the sheet is loading and
  // must not erase the correct count already visible on the card.
  var metricMyCount = card.myCount;
  if (rv.role === 'kam' && selfProgress && selfProgress.total != null) {
    metricMyCount = Math.max(Number(card.myCount || 0), Number(selfProgress.total || 0));
  }
  return { status:'OK', metric:{ id:card.id, myCount:metricMyCount, myRole:card.myRole,
    totalCases:card.totalCases, uniqueKams:card.uniqueKams, uniqueZhs:card.uniqueZhs,
    achievedPct:ach.pct, approached:ach.approached, notApproached:ach.notApproached,
    dropdownCounts:ach.counts, progressTotal:ach.total, yes:ach.achieved,
    no:ach.no, noPct:ach.noPct, pending:ach.pending,
    selfProgress:selfProgress, selfProgressTabs:selfProgressTabs, metricsPending:false } };
}

// =========================================================
// PERSONAL WORKING SHEETS FOR CENTRAL / CLUSTER DRIVES
// A KAM never edits the master tracker directly. Opening a drive creates a
// KAM-scoped working copy with the same formulas and formatting. Only the
// three tracker columns below flow back to the source sheet.
// =========================================================
const PERSONAL_DRIVE_SHEETS_PROP = 'PERSONAL_DRIVE_SHEETS_V1';
const PERSONAL_DRIVE_MAIN_ROW_HEADER = '__Brahmastra Main Row';

function personalDriveSheets_() {
  try { var raw = PropertiesService.getScriptProperties().getProperty(PERSONAL_DRIVE_SHEETS_PROP); return raw ? JSON.parse(raw) : {}; }
  catch (e) { return {}; }
}
function savePersonalDriveSheets_(map) {
  try { PropertiesService.getScriptProperties().setProperty(PERSONAL_DRIVE_SHEETS_PROP, JSON.stringify(map || {})); } catch (e) {}
}
function normalSheetHeader_(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function findSheetColumn_(headers, names) {
  var h = (headers || []).map(normalSheetHeader_);
  for (var i=0;i<names.length;i++) { var at = h.indexOf(normalSheetHeader_(names[i])); if (at !== -1) return at + 1; }
  return 0;
}
function ensureDriveTrackerColumns_(sh, rowLimit) {
  var headers = sh.getRange(1,1,1,Math.max(1,sh.getLastColumn())).getDisplayValues()[0];
  var want = [{label:'Approached', aliases:['approached','actiontaken']}, {label:'Comments', aliases:['comments','comment','input']}, {label:'Converted', aliases:['converted','convert']}];
  var out = {};
  want.forEach(function(item){
    var col = findSheetColumn_(headers, item.aliases);
    if (!col) {
      col = sh.getLastColumn() + 1;
      sh.getRange(1,col).setValue(item.label).setFontWeight('bold').setBackground('#FCE7F3').setFontColor('#9D174D');
      headers[col-1] = item.label;
    }
    out[item.label] = col;
  });
  // Validating every unused row in a copied workbook is extremely expensive
  // and can leave the Apps Script call running until timeout. Only the rows
  // that can actually contain cases need dropdowns.
  var rows = Math.max(1, Number(rowLimit || 0) || Math.max(1, sh.getLastRow() - 1));
  ['Approached','Converted'].forEach(function(key){
    sh.getRange(2,out[key],rows,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Yes','No'], true).setAllowInvalid(false).build());
  });
  return out;
}

// Central and Cluster drives are live trackers from the moment they are added.
// Keep the three universal tracker columns on the *source* tab as well as on
// KAM working copies.  This makes progress available before any KAM opens or
// creates a personal sheet, and also repairs older drives on their next read.
function ensureDriveSourceTracker_(drive) {
  var sheetId = sheetIdFromUrl_(drive && drive.url);
  if (!sheetId) return null;
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = drive && drive.leadTab
    ? (ss.getSheetByName(drive.leadTab) || ss.getSheets()[0])
    : ss.getSheets()[0];
  var tracker = ensureDriveTrackerColumns_(sh);
  return { sheet:sh, tracker:tracker };
}
function makePersonalDriveKey_(driveId, email) { return String(driveId||'') + '::' + String(email||'').trim().toLowerCase(); }

// Personal KAM working sheets stay with the relevant lead lists, never in
// My Drive root: Lead Lists / <Cluster> / <Central | Cluster | Self Made>.
function personalDriveFolder_(drive, fallbackCluster) {
  var clusterName = String((drive && (drive.cluster || drive.clusterKey)) || fallbackCluster || 'Unassigned Cluster')
    .replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unassigned Cluster';
  var kind = String((drive && drive.driveType) || (drive && drive.selfMade ? 'Self Made' : 'Cluster')).trim();
  if (!/^(central|cluster|self made)$/i.test(kind)) kind = 'Cluster';
  kind = /^central$/i.test(kind) ? 'Central' : (/^self made$/i.test(kind) ? 'Self Made' : 'Cluster');
  return getClusterSubfolder_(getClusterSubfolder_(LEADLIST_FOLDER_ID, clusterName).getId(), kind);
}

// Called from the Ongoing Drive card. If a personal sheet already exists, the
// same URL is returned. Otherwise the configured lead tab is copied exactly,
// then reduced to only the KAM's source rows.
function openPersonalDriveSheet(id, viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || ''); setViewAsKam_(viewAsKam || ''); setViewer_(viewer);
  var ctx = getUserContext();
  // Preview mode must build the selected KAM's sheet, not the admin's own
  // email. For normal KAM usage this naturally falls back to their login.
  var email = String(viewAsKam || ctx.email || viewer || '').trim().toLowerCase();
  var visible = getDrives(viewer, clusterOverride, viewAsKam, false).drives || [];
  var card = visible.filter(function(d){ return String(d.id) === String(id); })[0];
  if (!card) return { status:'FORBIDDEN' };
  var drives = drivesAll_(), d = drives.filter(function(x){ return String(x.id) === String(id); })[0];
  if (!d) return { status:'NOT_FOUND' };
  // Self-made lists already are their own working trackers. Every Central /
  // Cluster drive, including older records without saved column metadata,
  // must go through the personal-sheet flow.
  if (d.selfMade) return { status:'DIRECT', url:d.url };
  var key = makePersonalDriveKey_(d.id, email), maps = personalDriveSheets_(), old = maps[key];
  if (old && old.url) {
    try {
      var oldBook = SpreadsheetApp.openById(old.sheetId);
      var oldTab = old.parentTab ? (oldBook.getSheetByName(old.parentTab) || oldBook.getSheets()[0]) : oldBook.getSheets()[0];
      var oldHeaders = oldTab.getRange(1,1,1,Math.max(1,oldTab.getLastColumn())).getDisplayValues()[0];
      var oldResCol = findSheetColumn_(oldHeaders,['res id','res_id','resid','restaurant id','restaurant_id','restaurantid','res name','res_name','restaurant']);
      var oldRows = oldTab.getLastRow() > 1 ? oldTab.getRange(2,1,oldTab.getLastRow()-1,Math.max(1,oldTab.getLastColumn())).getDisplayValues() : [];
      var oldCount = oldRows.filter(function(row){
        if (oldResCol > 0) return !!String(row[oldResCol-1] || '').trim();
        return row.some(function(v){ return !!String(v || '').trim(); });
      }).length;
      var expectedOldCount = Number((d.kamCounts || {})[email] || card.myCount || 0);
      // Keep a healthy existing tracker and its edits. A historical 0/1-row
      // copy against a larger saved allocation is rebuilt on this click;
      // the old file is left untouched for recovery.
      if (!expectedOldCount || oldCount >= expectedOldCount) return { status:'OK', url:old.url, existing:true, count:oldCount };
    }
    catch (e) { delete maps[key]; savePersonalDriveSheets_(maps); }
  }
  var parentId = sheetIdFromUrl_(d.url); if (!parentId) return { status:'BAD_URL' };
  try {
    var parent = SpreadsheetApp.openById(parentId);
    var source = d.leadTab ? (parent.getSheetByName(d.leadTab) || parent.getSheets()[0]) : parent.getSheets()[0];
    var parentTracker = ensureDriveTrackerColumns_(source);
    var sourceHeaders = source.getRange(1,1,1,source.getLastColumn()).getDisplayValues()[0];
    var kamCol = colLetterToIndex_(d.kamCol) + 1;
    if (kamCol < 1 || kamCol > source.getLastColumn()) kamCol = findSheetColumn_(sourceHeaders,['kam','kam email','kam_email','am','am email','am_email']);
    // Resolve Res ID independently even when a KAM column exists. Certain
    // source sheets contain stale/formatted KAM cells; AMTL/master mapping is
    // then the reliable way to retain every one of the KAM's cases.
    var resCol = findSheetColumn_(sourceHeaders,['res id','res_id','resid','restaurant id','restaurant_id','restaurantid']);
    if (kamCol < 1 && resCol < 1) return { status:'NO_SCOPE_COLUMN', message:'This drive needs either a KAM email column or a Res ID column to create personal KAM sheets.' };
    var masterKamByRes = {};
    if (resCol > 0) loadMaster_().forEach(function(r){ masterKamByRes[normId_(r.res_id)] = String(r.kam_email||'').trim().toLowerCase(); });
    // Filter before creating/copying the workbook. The previous flow copied
    // and rewrote the entire source once, then read and cleared it again;
    // large Central drives could time out and leave the CTA stuck on
    // "Creating My Sheet…". Read the source only once and retain only this
    // KAM's evaluated rows.
    var sourceRange = source.getDataRange();
    var sourceValues = sourceRange.getValues();
    var ownRows = [], ownMainRows = [];
    for (var sr=1; sr<sourceValues.length; sr++) {
      var rowKam = kamCol > 0 ? String(sourceValues[sr][kamCol-1] || '').trim().toLowerCase() : '';
      var mappedKam = resCol > 0 ? String(masterKamByRes[normId_(sourceValues[sr][resCol-1])] || '').trim().toLowerCase() : '';
      if (rowKam === email || mappedKam === email) {
        ownRows.push(sourceValues[sr].slice());
        ownMainRows.push([sr + 1]);
      }
    }
    if (!ownRows.length) return { status:'NO_KAM_CASES', message:'No source rows are mapped to ' + email + '.' };
    var target = SpreadsheetApp.create(String(d.name || 'Drive') + ' — ' + leadDrivePersonName_(email));
    var copied = source.copyTo(target).setName(source.getName());
    target.deleteSheet(target.getSheets()[0]);
    // KAM sheets are operational working copies, not live formula models.
    // Keep source formatting, clear its copied data rows in one operation,
    // then write only this KAM's evaluated values (never the whole drive).
    var copiedBodyRows = Math.max(0, copied.getLastRow() - 1);
    if (copiedBodyRows) copied.getRange(2,1,copiedBodyRows,copied.getLastColumn()).clearContent();
    if (ownRows.length) copied.getRange(2,1,ownRows.length,ownRows[0].length).setValues(ownRows);
    var childTracker = ensureDriveTrackerColumns_(copied, ownRows.length);
    var helper = copied.getLastColumn() + 1;
    copied.getRange(1,helper).setValue(PERSONAL_DRIVE_MAIN_ROW_HEADER);
    copied.getRange(2,helper,ownMainRows.length,1).setValues(ownMainRows);
    copied.hideColumns(helper);
    // SpreadsheetApp.create always starts in My Drive root. Move the finished
    // working sheet into the matching cluster/type folder before exposing it.
    var personalFolder = personalDriveFolder_(d, ctx.cluster || clusterOverride || '');
    try {
      var personalFile = DriveApp.getFileById(target.getId());
      personalFolder.addFile(personalFile);
      try { DriveApp.getRootFolder().removeFile(personalFile); } catch (rootMoveErr) {}
    } catch (folderErr) {}
    try { DriveApp.getFileById(target.getId()).addEditor(email); } catch (shareErr) {}
    maps[key] = { sheetId:target.getId(), url:target.getUrl(), driveId:d.id, parentId:parentId, parentTab:source.getName(), email:email, folderId:personalFolder.getId(), email:email, createdAt:new Date().toISOString() };
    savePersonalDriveSheets_(maps);
    ensurePersonalDriveEditTrigger_(target.getId());
    return { status:'OK', url:target.getUrl(), existing:false, count:Math.max(0,copied.getLastRow()-1) };
  } catch (e) { return { status:'ERROR', message:String(e && e.message || e) }; }
}

function ensurePersonalDriveEditTrigger_(sheetId) {
  try {
    var exists = ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'syncPersonalDriveEdit' && String(t.getTriggerSourceId() || '') === String(sheetId); });
    if (!exists) ScriptApp.newTrigger('syncPersonalDriveEdit').forSpreadsheet(sheetId).onEdit().create();
  } catch (e) { /* Personal sheet remains usable; a retry happens on its next open. */ }
}

// Installable trigger for a personal working sheet. It deliberately accepts
// only Approached, Comments and Converted, so formulas/numbers in the master
// can never be overwritten by a KAM edit.
function syncPersonalDriveEdit(e) {
  if (!e || !e.range) return;
  var child = e.range.getSheet(), ssId = child.getParent().getId(), maps = personalDriveSheets_(), map = null;
  Object.keys(maps).some(function(k){ if (String(maps[k].sheetId) === String(ssId)) { map=maps[k]; return true; } return false; });
  if (!map || child.getName() !== map.parentTab || e.range.getRow() < 2) return;
  var childHeaders = child.getRange(1,1,1,child.getLastColumn()).getDisplayValues()[0];
  var helper = findSheetColumn_(childHeaders,[PERSONAL_DRIVE_MAIN_ROW_HEADER]);
  if (!helper) return;
  var parent = SpreadsheetApp.openById(map.parentId), main = parent.getSheetByName(map.parentTab);
  if (!main) return;
  var parentTracker = ensureDriveTrackerColumns_(main);
  var tracked = { Approached:findSheetColumn_(childHeaders,['approached','actiontaken']), Comments:findSheetColumn_(childHeaders,['comments','comment','input']), Converted:findSheetColumn_(childHeaders,['converted','convert']) };
  var r1=e.range.getRow(), r2=r1+e.range.getNumRows()-1, c1=e.range.getColumn(), c2=c1+e.range.getNumColumns()-1;
  Object.keys(tracked).forEach(function(name){
    var cc=tracked[name]; if (!cc || cc<c1 || cc>c2) return;
    for (var row=r1;row<=r2;row++) {
      var mainRow=Number(child.getRange(row,helper).getValue());
      if (mainRow >= 2) main.getRange(mainRow,parentTracker[name]).setValue(child.getRange(row,cc).getValue());
    }
  });
}

// Live progress for auto-created card / overall lead lists.  Scope is the same
// as the orange Self Made card itself: KAM = own cases, ZH = mapped KAMs,
// creator = whole list. Cache briefly to avoid repeatedly opening Sheets while
// still letting dashboard refreshes reflect team updates quickly.
function selfMadeLeadProgress_(d, rv, email) {
  var id = sheetIdFromUrl_(d.url);
  if (!id) return null;
  email = String(email||'').toLowerCase();
  // KAM and ZH always see their own mapped scope, even when they created the
  // lead list. Only a CEO/Super creator is the whole-list owner.
  var wholeListOwner = String(d.createdBy||'').toLowerCase() === email &&
    (rv.role === 'ceo' || rv.role === 'super');
  var scopeKey = wholeListOwner ? 'owner' : (rv.role || 'unknown') + ':' + email;
  var cacheKey = 'selfLeadProgress_' + d.id + '_' + scopeKey.replace(/[^a-z0-9]/g,'_');
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  var out = null;
  try {
    var ss = SpreadsheetApp.openById(id);
    var sh = d.leadTab ? (ss.getSheetByName(d.leadTab) || ss.getSheets()[0]) : ss.getSheets()[0];
    var values = sh.getDataRange().getDisplayValues();
    if (values.length < 2) return { total:0, achieved:0, achievedPct:0, converted:0, convertedPct:null, actionLabel:'Approached' };
    var head = values.shift().map(function(h){ return String(h||'').toLowerCase().replace(/[^a-z0-9]/g,''); });
    var col = function(names){
      for (var i=0;i<names.length;i++) { var n=names[i]; var p=head.indexOf(n); if(p!==-1) return p; }
      return -1;
    };
    var iKam = col(['kam','kamemail','am','amemail']), iZh = col(['zh','zhemail','tl','tlemail']);
    var iRes = col(['resid','restaurantid','resname','restaurant']);
    var iAction = col(['approached','actiontaken']), iConverted = col(['converted']);
    var yes = function(v){ v=String(v||'').trim().toLowerCase(); return v==='yes'||v==='y'||v==='done'||v==='achieved'||v==='live'; };
    var total=0, achieved=0, declined=0, pending=0, converted=0;
    values.forEach(function(row){
      if (iRes >= 0 && !String(row[iRes]||'').trim()) return;
      var kam = iKam>=0 ? String(row[iKam]||'').trim().toLowerCase() : '';
      var zh = iZh>=0 ? String(row[iZh]||'').trim().toLowerCase() : '';
      if (rv.role === 'kam' && kam && kam !== email) return;
      if (rv.role === 'zh' && zh && zh !== email && (rv.kams||[]).indexOf(kam) === -1) return;
      total++;
      if (iAction >= 0) {
        var action = String(row[iAction] || '').trim().toLowerCase();
        if (yes(action)) achieved++;
        else if (action === 'no' || action === 'n') declined++;
        else pending++;
      }
      if (iConverted >= 0 && yes(row[iConverted])) converted++;
    });
    out = {
      total:total, achieved:achieved, achievedPct:total ? Math.round(achieved/total*100) : 0,
      no:declined, noPct:total ? Math.round(declined/total*100) : 0,
      pending:pending,
      converted:iConverted >= 0 ? converted : null,
      convertedPct:iConverted >= 0 && total ? Math.round(converted/total*100) : (iConverted >= 0 ? 0 : null),
      actionLabel: head[iAction] === 'actiontaken' ? 'Actioned' : 'Approached'
    };
  } catch (e) { return null; }
  try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(out), 90); } catch(e) {}
  return out;
}

// Overall NOV/CM workbooks contain a Summary tab plus one sheet per lever.
// The Summary tab is intentionally excluded: its cells are formulas and do
// not carry the row-level Approached / Converted values.  Read every actual
// lead tab in one Spreadsheet open so the Ongoing Drive card can show a
// separate progress bar (and refresh control) for each metric.
function selfMadeLeadProgressTabs_(d, rv, email) {
  var id = sheetIdFromUrl_(d.url);
  if (!id) return null;
  email = String(email || '').toLowerCase();
  var wholeListOwner = String(d.createdBy || '').toLowerCase() === email &&
    (rv.role === 'ceo' || rv.role === 'super');
  var scopeKey = wholeListOwner ? 'owner' : (rv.role || 'unknown') + ':' + email;
  var cacheKey = 'selfLeadProgressTabs_' + d.id + '_' + scopeKey.replace(/[^a-z0-9]/g, '_');
  try { var cached = CacheService.getScriptCache().get(cacheKey); if (cached) return JSON.parse(cached); } catch (e) {}
  try {
    var ss = SpreadsheetApp.openById(id), tabs = [];
    var yes = function(v){ v=String(v||'').trim().toLowerCase(); return v==='yes'||v==='y'||v==='done'||v==='achieved'||v==='live'; };
    ss.getSheets().forEach(function(sh){
      if (String(sh.getName()).toLowerCase() === 'summary') return;
      var values = sh.getDataRange().getDisplayValues();
      if (values.length < 1) return;
      var head = values.shift().map(normalSheetHeader_);
      var find = function(names){ for(var i=0;i<names.length;i++){ var p=head.indexOf(names[i]); if(p!==-1)return p; } return -1; };
      var iKam=find(['kam','kamemail','am','amemail']), iZh=find(['zh','zhemail','tl','tlemail']);
      var iRes=find(['resid','restaurantid','resname','restaurant']);
      var iAction=find(['approached','actiontaken']), iConverted=find(['converted']);
      // Ignore auxiliary tabs that are not lead-list sheets.
      if (iAction < 0 || iRes < 0) return;
      var total=0, achieved=0, no=0, pending=0, converted=0;
      values.forEach(function(row){
        if (!String(row[iRes] || '').trim()) return;
        var kam=iKam>=0 ? String(row[iKam]||'').trim().toLowerCase() : '';
        var zh=iZh>=0 ? String(row[iZh]||'').trim().toLowerCase() : '';
        if (rv.role === 'kam' && kam && kam !== email) return;
        if (rv.role === 'zh' && zh && zh !== email && (rv.kams||[]).indexOf(kam) === -1) return;
        total++;
        var action=String(row[iAction]||'').trim().toLowerCase();
        if (yes(action)) achieved++; else if (action==='no'||action==='n') no++; else pending++;
        if (iConverted >= 0 && yes(row[iConverted])) converted++;
      });
      tabs.push({ label:sh.getName(), total:total, achieved:achieved,
        achievedPct:total ? Math.round(achieved / total * 100) : 0,
        no:no, noPct:total ? Math.round(no / total * 100) : 0, pending:pending,
        converted:iConverted >= 0 ? converted : null,
        convertedPct:iConverted >= 0 ? (total ? Math.round(converted / total * 100) : 0) : null,
        actionLabel:head[iAction] === 'actiontaken' ? 'Actioned' : 'Approached' });
    });
    try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(tabs), 90); } catch (ignore) {}
    return tabs;
  } catch (e) { return null; }
}

// Progress used by Central/Cluster ongoing drives. It reads the universal
// Approached/Action Taken column and scopes the result to the viewer's own
// KAM cases (or mapped ZH cases), so a Yes/No update is immediately visible
// on that drive card as a true achievement percentage.
function driveScopedTrackerProgress_(d, rv, email) {
  var id = sheetIdFromUrl_(d.url);
  if (!id) return { pct:null, approached:null, notApproached:null, counts:null };
  email = String(email || '').trim().toLowerCase();
  // Once a KAM has a personal working sheet, that is the authoritative
  // assignment list for the card. Reading the master sheet here could count
  // rows belonging to other KAMs when an older drive has blank/misaligned KAM
  // cells, making "Your cases" larger than the KAM's own sheet.
  if (rv.role === 'kam') {
    var mine = personalDriveTrackerProgress_(d, email);
    if (mine) return mine;
  }
  // Add the tracker headers for older Central/Cluster drives too.  Therefore a
  // card never waits for a KAM to create their personal copy before it can
  // show the initial 0% progress bar.
  var source = ensureDriveSourceTracker_(d);
  if (!source || !source.sheet) return { pct:null, approached:null, notApproached:null, counts:null };
  var sh = source.sheet;
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return { total:0, achieved:0, achievedPct:0, no:0, noPct:0, pending:0, actionLabel:'Approached' };
  var head = values.shift().map(function(h){ return normalSheetHeader_(h); });
  var find = function(names){ for (var i=0;i<names.length;i++) { var p=head.indexOf(names[i]); if (p !== -1) return p; } return -1; };
  var iAction=find(['approached','actiontaken']), iKam=find(['kam','kamemail','am','amemail']), iZh=find(['zh','zhemail','tl','tlemail']);
  var iRes=find(['resid','restaurantid','resname','restaurant']);
  // Drive setup stores the administrator-selected column letters. Use those
  // when a source template has decorative/non-standard headers.
  var configuredKam = colLetterToIndex_(d.kamCol), configuredZh = colLetterToIndex_(d.zhCol);
  if (iKam < 0 && configuredKam >= 0 && configuredKam < head.length) iKam = configuredKam;
  if (iZh < 0 && configuredZh >= 0 && configuredZh < head.length) iZh = configuredZh;
  if (iAction < 0) return { pct:null, approached:null, notApproached:null, counts:null };
  // A few legacy drive templates do not include KAM email. Use AMTL mapping
  // through Res ID in that case, rather than treating every blank row as the
  // current KAM's case.
  var masterKamByRes = {};
  if (iRes >= 0) {
    loadMaster_().forEach(function(r){ masterKamByRes[normId_(r.res_id)] = String(r.kam_email||'').trim().toLowerCase(); });
  }
  var total=0, yes=0, no=0, pending=0, counts={};
  values.forEach(function(row){
    if (iRes >= 0 && !String(row[iRes] || '').trim()) return;
    var kam=iKam>=0 ? String(row[iKam] || '').trim().toLowerCase() : '';
    var zh=iZh>=0 ? String(row[iZh] || '').trim().toLowerCase() : '';
    if (rv.role === 'kam') {
      var mappedKam = iRes >= 0 ? String(masterKamByRes[normId_(row[iRes])] || '').trim().toLowerCase() : '';
      var isMyKamRow = kam === email || mappedKam === email;
      if (!isMyKamRow) return;
    }
    if (rv.role === 'zh') {
      var isMyTeamRow = (zh && zh === email) || (kam && (rv.kams || []).indexOf(kam) !== -1);
      if (!isMyTeamRow) return;
    }
    total++;
    var answer=String(row[iAction] || '').trim(), key=answer.toLowerCase();
    if (answer) counts[answer]=(counts[answer] || 0)+1;
    if (key === 'yes' || key === 'y' || key === 'done' || key === 'achieved' || key === 'live') yes++;
    else if (key === 'no' || key === 'n') no++;
    else pending++;
  });
  return { total:total, achieved:yes, achievedPct:total ? Math.round(yes/total*100) : 0,
    no:no, noPct:total ? Math.round(no/total*100) : 0, pending:pending,
    pct:total ? Math.round(yes/total*100) : 0, approached:yes + no, notApproached:pending,
    counts:counts, actionLabel:head[iAction] === 'actiontaken' ? 'Actioned' : 'Approached' };
}

// Read a KAM's personal working copy. Its data rows were created from that
// KAM's allocation only, so this gives an exact progress denominator and
// remains correct even if the master drive has stale or blank KAM cells.
function personalDriveTrackerProgress_(d, email) {
  try {
    var map = personalDriveSheets_()[makePersonalDriveKey_(d.id, email)];
    if (!map || !map.sheetId) return null;
    var ss = SpreadsheetApp.openById(map.sheetId);
    var sh = map.parentTab ? (ss.getSheetByName(map.parentTab) || ss.getSheets()[0]) : ss.getSheets()[0];
    var values = sh.getDataRange().getDisplayValues();
    if (values.length < 2) return { total:0, achieved:0, achievedPct:0, no:0, noPct:0, pending:0, pct:0, approached:0, notApproached:0, counts:{}, actionLabel:'Approached' };
    var head = values.shift().map(normalSheetHeader_);
    var find = function(names){ for (var i=0;i<names.length;i++){ var p=head.indexOf(names[i]); if(p!==-1)return p; } return -1; };
    var iAction=find(['approached','actiontaken']), iRes=find(['resid','restaurantid','resname','restaurant']);
    if (iAction < 0) return null;
    var total=0, yes=0, no=0, pending=0, counts={};
    values.forEach(function(row){
      if (iRes >= 0 && !String(row[iRes] || '').trim()) return;
      // A source without a recognised Res column still has only the KAM's
      // copied rows; ignore wholly blank rows left behind by the clear step.
      if (iRes < 0 && !row.some(function(v){ return String(v || '').trim(); })) return;
      total++;
      var answer=String(row[iAction] || '').trim(), key=answer.toLowerCase();
      if (answer) counts[answer]=(counts[answer] || 0)+1;
      if (key === 'yes' || key === 'y' || key === 'done' || key === 'achieved' || key === 'live') yes++;
      else if (key === 'no' || key === 'n') no++;
      else pending++;
    });
    return { total:total, achieved:yes, achievedPct:total ? Math.round(yes/total*100) : 0,
      no:no, noPct:total ? Math.round(no/total*100) : 0, pending:pending,
      pct:total ? Math.round(yes/total*100) : 0, approached:yes + no, notApproached:pending,
      counts:counts, actionLabel:head[iAction] === 'actiontaken' ? 'Actioned' : 'Approached' };
  } catch (e) { return null; }
}

// Hierarchy drill-down used by Ongoing Drives. It is deliberately on-demand:
// one sheet read only after the status button is clicked. CEO receives its
// own ZH → KAM structure; TL/ZH receives only their mapped KAMs.
function getDriveKamStatuses(id, viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || ''); setViewAsKam_(viewAsKam || ''); setViewer_(viewer);
  var visible = getDrives(viewer, clusterOverride, viewAsKam, false).drives || [];
  var card = visible.filter(function(d){ return String(d.id) === String(id); })[0];
  if (!card) return { status:'FORBIDDEN', kams:[] };
  var ctx=getUserContext(), rv=resolveViewer_(String(ctx.actualEmail||viewer||'').toLowerCase(), clusterOverride||'');
  // `zh` is the canonical backend role; accept `tl` as well. CEOs can view
  // the ZH → KAM hierarchy for the cluster they are currently viewing.
  if (rv.role !== 'ceo' && rv.role !== 'zh' && rv.role !== 'tl') return { status:'FORBIDDEN', kams:[] };
  var raw=drivesAll_().filter(function(d){ return String(d.id) === String(id); })[0];
  if (!raw) return { status:'NOT_FOUND', kams:[] };
  try {
    // Status must never depend on the source workbook having one exact header
    // layout. Older Central/Cluster drives may have neither KAM nor tracker
    // columns on the master tab, while their saved allocation and KAM working
    // sheets are still perfectly valid. Start with that stable allocation,
    // then overlay live personal-sheet/source progress wherever available.
    var scopedRaw=scopeDriveToCluster_(raw,rv), assignedCounts=scopedRaw.kamCounts||{};
    var allowed=(rv.role==='ceo'
      ? Object.keys(assignedCounts)
      : (rv.kams||[]).map(function(x){return String(x||'').trim().toLowerCase();})
    ).filter(function(k){return !!k && (assignedCounts[k]!=null || rv.role==='ceo');});
    var out={}, kamToZh={};
    loadMaster_().forEach(function(r){
      if (rv.role !== 'super' && clusterKey_(r.city_cluster||'') !== clusterKey_(rv.cluster||'')) return;
      var k=String(r.kam_email||'').trim().toLowerCase(), z=String(r.zh_email||'').trim().toLowerCase();
      if(k) kamToZh[k]=z;
    });
    if(rv.role==='zh'||rv.role==='tl'){
      var effectiveZh=String(ctx.email||viewer||'').trim().toLowerCase();
      Object.keys(assignedCounts).forEach(function(k){
        k=String(k||'').trim().toLowerCase();
        if(k && kamToZh[k]===effectiveZh && allowed.indexOf(k)===-1) allowed.push(k);
      });
    }
    allowed.forEach(function(k){
      var total=Math.max(0,Number(assignedCounts[k]||0));
      out[k]={email:k,zh:kamToZh[k]||'',total:total,yes:0,no:0,pending:total};
      var personal=personalDriveTrackerProgress_(raw,k);
      if(personal && personal.total!=null){
        // Do not let an old partial working copy shrink the saved allocation;
        // rows not readable from it are simply pending.
        var stableTotal=Math.max(total,Number(personal.total||0));
        out[k].total=stableTotal;
        out[k].yes=Math.max(0,Number(personal.achieved||0));
        out[k].no=Math.max(0,Number(personal.no||0));
        out[k].pending=Math.max(0,stableTotal-out[k].yes-out[k].no);
      }
    });

    // If the master tab does contain live tracker columns, prefer those live
    // values. KAM can be resolved either directly or through Res ID → AMTL.
    var sid=sheetIdFromUrl_(raw.url);
    if(sid){
      var ss=SpreadsheetApp.openById(sid), sh=raw.leadTab ? (ss.getSheetByName(raw.leadTab)||ss.getSheets()[0]) : ss.getSheets()[0];
      var values=sh.getDataRange().getDisplayValues();
      if(values.length>=2){
        var head=values.shift().map(normalSheetHeader_);
        var find=function(names){ for(var i=0;i<names.length;i++){ var p=head.indexOf(names[i]); if(p!==-1)return p; } return -1; };
        var configuredKam=colLetterToIndex_(raw.kamCol);
        var iKam=(configuredKam>=0 && configuredKam<head.length) ? configuredKam : find(['kam','kamemail','am','amemail']);
        var iZh=find(['zh','zhemail','tl','tlemail']), iRes=find(['resid','restaurantid','resname','restaurant']), iAction=find(['approached','actiontaken']);
        if(iAction>=0 && (iKam>=0 || iRes>=0)){
          var masterKamByRes={};
          if(iRes>=0) loadMaster_().forEach(function(r){ masterKamByRes[normId_(r.res_id)]=String(r.kam_email||'').trim().toLowerCase(); });
          var live={};
          values.forEach(function(row){
            if(iRes>=0&&!String(row[iRes]||'').trim()) return;
            var kam=iKam>=0 ? String(row[iKam]||'').trim().toLowerCase() : '';
            if(!kam && iRes>=0) kam=masterKamByRes[normId_(row[iRes])]||'';
            if(!kam||allowed.indexOf(kam)===-1)return;
            var zh=iZh>=0 ? String(row[iZh]||'').trim().toLowerCase() : (kamToZh[kam]||'');
            if(!live[kam])live[kam]={email:kam,zh:zh||kamToZh[kam]||'',total:0,yes:0,no:0,pending:0};
            var x=live[kam], a=String(row[iAction]||'').trim().toLowerCase(); x.total++;
            if(a==='yes'||a==='y'||a==='done'||a==='achieved'||a==='live')x.yes++;
            else if(a==='no'||a==='n')x.no++; else x.pending++;
          });
          Object.keys(live).forEach(function(k){
            var saved=Math.max(0,Number(assignedCounts[k]||0)), x=live[k];
            x.total=Math.max(saved,x.total); x.pending=Math.max(0,x.total-x.yes-x.no); out[k]=x;
          });
        }
      }
    }
    var kams=Object.keys(out).map(function(k){ var x=out[k]; x.pct=x.total?Math.round(x.yes/x.total*100):0; x.noPct=x.total?Math.round(x.no/x.total*100):0; return x; }).sort(function(a,b){return a.pct-b.pct||a.email.localeCompare(b.email);});
    return {status:'OK', driveName:raw.name||'', viewerRole:rv.role, kams:kams};
  } catch(e) { return {status:'ERROR', message:String(e), kams:[]}; }
}

function canManageDrivesAndNotifs_(ctx) {
  var role = String((ctx && ctx.role) || '').toLowerCase();
  return !!(ctx && (ctx.isAdmin || ctx.actualIsAdmin || role === 'ceo' || role === 'zh'));
}

// Settings → Run a Drive is a management screen, not a browsing screen.
// Cluster users see only drives they created themselves. Super Core admins can
// manage every drive, including their own cross-cluster drives.
function getManagedDrives(viewer, clusterOverride) {
  var all = getDrives(viewer, clusterOverride).drives || [];
  var actual = String(__VIEWER_EMAIL || viewer || '').toLowerCase();
  var superUser = isSuperUser_(actual);
  return { status:'OK', drives:all.filter(function(d){ return superUser || String(d.createdBy||'').toLowerCase() === actual; }) };
}

// A self-made lead list is complete only when its original creator marks it
// complete. The card moves out of All and appears under Self Made → Completed;
// the source Sheet remains intact and accessible through its existing link.
function completeSelfMadeDrive(id, viewer, clusterOverride, viewAsKam) {
  setClusterOverride_(clusterOverride || '');
  setViewAsKam_(viewAsKam || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  var actual = String(ctx.actualEmail || viewer || '').trim().toLowerCase();
  var list = drivesAll_(), found = null;
  for (var i=0;i<list.length;i++) if (String(list[i].id) === String(id)) { found = list[i]; break; }
  if (!found) return { status:'NOT_FOUND' };
  if (!found.selfMade || String(found.createdBy||'').toLowerCase() !== actual) return { status:'FORBIDDEN' };
  found.completed = true;
  found.completedAt = new Date().toISOString();
  drivesSave_(list);
  return getDrives(viewer, clusterOverride || '', viewAsKam || '');
}

/**
 * Read the achievement column of a drive's lead tab and summarise:
 *  - "yes" (any case) => achieved
 *  - blank => not approached
 *  - anything else => approached-but-not-yet (counted as approached)
 * Returns { pct, approached, notApproached, counts:{value->n} }.
 */
function driveAchievement_(driveId, tabName, colLetter, onlyClusterKey) {
  var d = drivesAll_().filter(function(x){ return x.id === driveId; })[0];
  if (!d) return { pct:null, approached:null, notApproached:null, counts:null };
  var id = sheetIdFromUrl_(d.url);
  if (!id) return { pct:null, approached:null, notApproached:null, counts:null };
  var ss = SpreadsheetApp.openById(id);
  var sh = tabName ? (ss.getSheetByName(tabName) || ss.getSheets()[0]) : ss.getSheets()[0];
  var idx = colLetterToIndex_(colLetter);
  if (idx < 0) return { pct:null, approached:null, notApproached:null, counts:null };
  var last = sh.getLastRow();
  if (last < 2) return { pct:0, approached:0, notApproached:0, counts:{} };
  var vals = sh.getRange(2, idx+1, last-1, 1).getValues();
  var clusterVals = null, clusterIdx = colLetterToIndex_(d.clusterCol || '');
  if (onlyClusterKey && clusterIdx >= 0) clusterVals = sh.getRange(2, clusterIdx+1, last-1, 1).getValues();
  var yes=0, blank=0, approached=0, counts={};
  vals.forEach(function(r, i){
    if (clusterVals && clusterKey_(clusterVals[i][0]) !== onlyClusterKey) return;
    var v = String(r[0]==null?'':r[0]).trim();
    if (v === '') { blank++; return; }
    var lv = v.toLowerCase();
    counts[v] = (counts[v]||0) + 1;
    if (lv === 'yes' || lv === 'y' || lv === 'done' || lv === 'achieved' || lv === 'live') { yes++; approached++; }
    else approached++;
  });
  var total = yes + blank + (approached - yes);
  var denom = clusterVals ? (yes + blank + (approached - yes)) : vals.length;
  return {
    pct: denom>0 ? Math.round(yes/denom*100) : 0,
    approached: approached, notApproached: blank, counts: counts
  };
}

// Admin: list the tab names of a linked sheet so they can pick the lead-list tab.
function getSheetTabs(url, viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!canManageDrivesAndNotifs_(ctx)) return { status:'FORBIDDEN', tabs: [] };
  var id = sheetIdFromUrl_(url);
  if (!id) return { status:'BAD_URL', tabs: [] };
  try {
    var ss = SpreadsheetApp.openById(id);
    return { status:'OK', tabs: ss.getSheets().map(function(s){ return s.getName(); }), title: ss.getName() };
  } catch (e) {
    return { status:'NO_ACCESS', tabs: [], message: (e && e.message) ? e.message : String(e) };
  }
}

// Admin: create a drive + broadcast a notification to all users.
function addDrive(payload, viewer, clusterOverride) {
  setClusterOverride_(clusterOverride || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!canManageDrivesAndNotifs_(ctx)) return { status:'FORBIDDEN' };
  payload = payload || {};
  var name = String(payload.name || '').trim();
  var url  = String(payload.url  || '').trim();
  var actualEmail = String(ctx.actualEmail || viewer || '').toLowerCase();
  var rv = resolveViewer_(actualEmail, clusterOverride || '');
  var creatorIsSuper = isSuperUser_(actualEmail);
  if (!name) return { status:'NO_NAME' };
  var id = sheetIdFromUrl_(url);
  if (!id)  return { status:'BAD_URL' };
  if ((creatorIsSuper || !rv.cluster) && !String(payload.clusterCol || '').trim()) return { status:'NEED_CLUSTER_COLUMN' };
  try { SpreadsheetApp.openById(id).getName(); } catch (e) { /* may be shared later; don't hard-fail */ }

  var drive = {
    id: 'DRV' + Date.now() + Math.floor(Math.random() * 1000),
    name: name, url: url, leadTab: String(payload.leadTab || ''),
    startDate: String(payload.startDate || ''), endDate: String(payload.endDate || ''),
    createdAt: new Date().toISOString(), createdBy: actualEmail,
    cluster: (!creatorIsSuper && rv.cluster) ? rv.cluster : '',
    clusterKey: (!creatorIsSuper && rv.cluster) ? clusterKey_(rv.cluster) : ''
  };

  // A drive becomes trackable immediately on creation.  Do this before the
  // case snapshot so Central and Cluster cards have Approached, Comments and
  // Converted available without any first-open / personal-sheet dependency.
  try {
    var trackerSource = ensureDriveSourceTracker_(drive);
    drive.trackerColumnsReady = !!(trackerSource && trackerSource.tracker);
  } catch (trackerErr) {
    // Preserve the existing add-drive behaviour for a sheet that is shared
    // after registration; its next metrics read will retry this setup.
    drive.trackerColumnsReady = false;
  }

  // Count cases per KAM (and per ZH if that column was provided) from the tab.
  var kamColIdx = colLetterToIndex_(payload.kamCol);
  var zhColIdx  = payload.zhCol ? colLetterToIndex_(payload.zhCol) : -1;
  var clusterColIdx = payload.clusterCol ? colLetterToIndex_(payload.clusterCol) : -1;
  var counts = (kamColIdx >= 0 || zhColIdx >= 0)
    ? driveCountsFromSheet_(id, drive.leadTab, kamColIdx, zhColIdx, clusterColIdx)
    : { kam: {}, zh: {}, cases: 0, clusterCounts:{}, clusterKamCounts:{}, clusters:{} };
  if (creatorIsSuper && !Object.keys(counts.clusterCounts || {}).length) return { status:'NO_CLUSTER_ROWS' };
  drive.kamCol = String(payload.kamCol || '');
  drive.zhCol  = String(payload.zhCol || '');
  drive.clusterCol = String(payload.clusterCol || '');
  drive.driveType = (String(payload.driveType||'').toLowerCase() === 'central') ? 'Central'
                  : (String(payload.driveType||'').toLowerCase() === 'cluster' ? 'Cluster' : '');
  drive.achieveCol = String(payload.achieveCol || '');   // column letter for achievement tracking
  drive.kamCounts = counts.kam;
  drive.zhCounts  = counts.zh;
  drive.totalCases = counts.cases;
  drive.uniqueKams = Object.keys(counts.kam).length;
  drive.uniqueZhs  = Object.keys(counts.zh).length;
  drive.clusterCounts = counts.clusterCounts || {};
  drive.clusterKamCounts = counts.clusterKamCounts || {};
  drive.clusters = counts.clusters || {};
  // Cluster CEOs can create a drive without a per-row Cluster column because
  // their dashboard has exactly one resolved cluster. Store that scope so it
  // can never appear in a different cluster's Ongoing Drives.
  if (!Object.keys(drive.clusterCounts).length && drive.clusterKey) {
    drive.clusterCounts[drive.clusterKey] = drive.totalCases;
    drive.clusterKamCounts[drive.clusterKey] = drive.kamCounts;
    drive.clusters[drive.clusterKey] = drive.cluster;
  }

  // reminder day-parts (Morning/Afternoon/Evening/Night) chosen by the admin
  drive.notifySlots = Array.isArray(payload.notifySlots)
    ? payload.notifySlots.filter(function(s){ return ['morning','afternoon','evening','night'].indexOf(s) !== -1; })
    : [];
  drive.lastRemind = {};

  var list = drivesAll_(); list.unshift(drive); drivesSave_(list);
  try { archiveDriveSnapshot_(drive); } catch (e) {}
  if (drive.notifySlots.length) { try { ensureDriveReminderTrigger_(); } catch (e) {} }

  var range = (drive.startDate || drive.endDate)
    ? (' (' + (drive.startDate || '?') + (drive.endDate ? ' \u2192 ' + drive.endDate : '') + ')') : '';
  var caseLine = drive.totalCases
    ? (' It has ' + drive.totalCases + ' cases across ' + drive.uniqueKams + ' KAMs \u2014 open Ongoing Drives to see how many are yours.')
    : ' Open the Ongoing Drives tab to view it.';
  notifCreate_({
    type: 'drive', driveId: drive.id, url: drive.url,
    title: '\uD83D\uDE80 New Drive: ' + drive.name,
    body: 'A new drive "' + drive.name + '" is now live' + range + '.' + caseLine,
    expiresAt: drive.endDate ? (Date.parse(drive.endDate) + 2 * 86400000) : (Date.now() + 21 * 86400000),
    createdBy: ctx.email || '', audience: notificationAudienceForDrive_(drive)
  });

  return { status:'OK', drives: getManagedDrives(viewer, clusterOverride).drives };
}

function removeDrive(id, viewer, clusterOverride) {
  setClusterOverride_(clusterOverride || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  var actualEmail = String(ctx.actualEmail || viewer || '').toLowerCase();
  var drive = drivesAll_().filter(function(d){ return d.id === id; })[0];
  if (!drive) return { status:'NOT_FOUND' };
  if (!isSuperUser_(actualEmail) && String(drive.createdBy||'').toLowerCase() !== actualEmail) return { status:'FORBIDDEN' };
  drivesSave_(drivesAll_().filter(function(d){ return d.id !== id; }));
  // Removing a generated card/overall lead list is one lifecycle action:
  // remove its Ongoing Drive registration, its five-day reuse lock and its
  // central audit-log row. The original Sheet remains safe in Drive.
  if (drive.selfMade) {
    try { metricLeadCooldownRemoveByUrl_(drive.url); } catch (e) {}
    try { removeLeadListLogByUrl_(drive.url); } catch (e) {}
  }
  return { status:'OK', drives: getManagedDrives(viewer, clusterOverride).drives };
}

// Current day-part in the script's timezone.
function dayPartNow_() {
  var h = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'));
  if (h >= 5 && h <= 11) return 'morning';
  if (h >= 12 && h <= 16) return 'afternoon';
  if (h >= 17 && h <= 20) return 'evening';
  return 'night';
}

// Time-driven trigger (hourly): for each active drive whose reminder slots
// include the current day-part and that hasn't been reminded for this slot
// today, broadcast a reminder. Users see it once (client de-dupes).
function driveReminderTick() {
  var slot = dayPartNow_();
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var now = Date.now();
  var list = drivesAll_(), due = [];
  var slotLbl = { morning:'Morning', afternoon:'Afternoon', evening:'Evening', night:'Night' };
  list.forEach(function(d){
    if (!d.notifySlots || d.notifySlots.indexOf(slot) === -1) return;
    if (driveStatus_(d, now) !== 'active') return;
    d.lastRemind = d.lastRemind || {};
    if (d.lastRemind[slot] === today) return;   // already reminded this slot today
    due.push(d);
  });
  if (!due.length) return;
  due.forEach(function(d){ d.lastRemind[slot] = today; });

  var lbl = slotLbl[slot] || '';
  // One scoped alert per drive. Combining different drives into one reminder
  // would leak another cluster/KAM's drive name in the notification body.
  due.forEach(function(d){
    notifCreate_({
      type: 'reminder', driveId:d.id, url:d.url,
      title:'\u23F0 ' + lbl + ' reminder: ' + d.name,
      body:'Drive "' + d.name + '" is still on' + (d.endDate ? (' (ends ' + d.endDate + ')') : '') +
           '. Check your cases in the Ongoing Drives tab.',
      expiresAt:now + 8 * 3600000, createdBy:'system', audience:notificationAudienceForDrive_(d)
    });
  });
  drivesSave_(list);
}

// Install the hourly reminder trigger once (needs the ScriptApp scope; the
// deploying account will be asked to re-authorize the first time).
function ensureDriveReminderTrigger_() {
  var have = ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'driveReminderTick'; });
  if (!have) ScriptApp.newTrigger('driveReminderTick').timeBased().everyHours(1).create();
}

// ---- Notifications ----
// Notification data is intentionally kept in Drive, not Script Properties:
// a large audience creates many read receipts and can otherwise exceed the
// small Script Properties quota. Both JSON files are updated in place.
function notifStoreFolder_() {
  try {
    var parent = DriveApp.getFolderById(LEADLIST_LOG_FOLDER_ID);
    var it = parent.getFoldersByName(NOTIF_STORE_FOLDER_NAME);
    return it.hasNext() ? it.next() : parent.createFolder(NOTIF_STORE_FOLDER_NAME);
  } catch (e) { return null; }
}
function notifStoreFile_(fileName) {
  try {
    var folder = notifStoreFolder_();
    if (!folder) return null;
    var it = folder.getFilesByName(fileName);
    return it.hasNext() ? it.next() : folder.createFile(fileName, '');
  } catch (e) { return null; }
}
function notifDriveJson_(fileName, fallback) {
  var file = notifStoreFile_(fileName);
  if (!file) return { available:false, value:fallback };
  try {
    var raw = String(file.getBlob().getDataAsString() || '').trim();
    return raw ? { available:true, value:JSON.parse(raw), file:file } : { available:true, value:fallback, file:file, empty:true };
  } catch (e) { return { available:true, value:fallback, file:file, empty:true }; }
}
function notifDriveJsonSave_(fileName, value) {
  try {
    var file = notifStoreFile_(fileName);
    if (!file) return false;
    file.setContent(JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}
function notifsAll_() {
  var store = notifDriveJson_(NOTIF_STORE_FILE_NAME, []);
  if (store.available && !store.empty) return Array.isArray(store.value) ? store.value : [];
  // One-time migration of previously stored notifications.
  var legacy = [];
  try { var raw = PropertiesService.getScriptProperties().getProperty(NOTIF_PROP); legacy = raw ? JSON.parse(raw) : []; } catch (e) {}
  if (!Array.isArray(legacy)) legacy = [];
  if (store.available) notifDriveJsonSave_(NOTIF_STORE_FILE_NAME, legacy);
  return legacy;
}
function notifsSave_(list) {
  if (!notifDriveJsonSave_(NOTIF_STORE_FILE_NAME, Array.isArray(list) ? list : [])) {
    try { PropertiesService.getScriptProperties().setProperty(NOTIF_PROP, JSON.stringify(list || [])); } catch (e) {}
  }
}
function notifViewsAll_() {
  var store = notifDriveJson_(NOTIF_VIEWS_FILE_NAME, {});
  if (store.available && !store.empty) return (store.value && typeof store.value === 'object') ? store.value : {};
  // One-time migration of read receipts from Script Properties.
  var legacy = {};
  try { var raw = PropertiesService.getScriptProperties().getProperty(NOTIF_VIEWS_PROP); legacy = raw ? JSON.parse(raw) : {}; } catch (e) {}
  if (!legacy || typeof legacy !== 'object') legacy = {};
  if (store.available) notifDriveJsonSave_(NOTIF_VIEWS_FILE_NAME, legacy);
  return legacy;
}
function notifViewsSave_(map) {
  if (!notifDriveJsonSave_(NOTIF_VIEWS_FILE_NAME, map || {})) {
    try { PropertiesService.getScriptProperties().setProperty(NOTIF_VIEWS_PROP, JSON.stringify(map || {})); } catch (e) {}
  }
}
// Scope every notification before it reaches the browser. A KAM/TL/cluster
// must never receive another hierarchy's notification.
function notificationAudienceForDrive_(drive) {
  drive = drive || {};
  var clusters = Object.keys(drive.clusterCounts || {});
  if (!clusters.length && drive.clusterKey) clusters.push(clusterKey_(drive.clusterKey));
  var kams = drive.selfMade ? (drive.assignedKams || []) : Object.keys(drive.kamCounts || {});
  var zhs = drive.selfMade ? (drive.assignedZhs || []) : Object.keys(drive.zhCounts || {});
  kams = uniq_(kams.map(function(x){ return String(x||'').trim().toLowerCase(); }).filter(Boolean));
  zhs = uniq_(zhs.map(function(x){ return String(x||'').trim().toLowerCase(); }).filter(Boolean));
  var clusterKams = {}, clusterZhs = {};
  Object.keys(drive.clusterKamCounts || {}).forEach(function(ck){
    clusterKams[clusterKey_(ck)] = uniq_(Object.keys(drive.clusterKamCounts[ck] || {}).map(function(x){ return String(x||'').trim().toLowerCase(); }).filter(Boolean));
  });
  if (clusters.length === 1 && !clusterKams[clusters[0]]) clusterKams[clusters[0]] = kams.slice();
  // Uploaded drives may not contain a TL/ZH column, so derive TLs from AMTL.
  if (kams.length) loadMaster_().forEach(function(r){
    var ck = clusterKey_(r.city_cluster), rowKam = String(r.kam_email||'').trim().toLowerCase();
    if (clusters.length && clusters.indexOf(ck) === -1) return;
    var scopedKams = clusterKams[ck] || kams;
    if (scopedKams.indexOf(rowKam) === -1) return;
    var z = String(r.zh_email||'').trim().toLowerCase();
    if (z) { zhs.push(z); (clusterZhs[ck] || (clusterZhs[ck] = [])).push(z); }
  });
  Object.keys(clusterZhs).forEach(function(ck){ clusterZhs[ck] = uniq_(clusterZhs[ck]); });
  return { clusters:uniq_(clusters.filter(Boolean)), kams:kams, zhs:uniq_(zhs), clusterKams:clusterKams, clusterZhs:clusterZhs,
           creator:String(drive.createdBy||'').toLowerCase() };
}
function notificationAudienceForContext_(ctx) {
  ctx = ctx || {};
  var cluster = clusterKey_(ctx.cluster || '');
  // Super Core on All broadcasts intentionally; a concrete selected cluster
  // remains cluster-scoped.
  if (ctx.isSuper && (!cluster || cluster === 'super_core_admin')) return { all:true, creator:String(ctx.actualEmail||ctx.email||'').toLowerCase() };
  if (String(ctx.role||'').toLowerCase() === 'zh') {
    return { clusters:cluster?[cluster]:[], kams:ctx.kams||[], zhs:[String(ctx.email||'').toLowerCase()], creator:String(ctx.actualEmail||ctx.email||'').toLowerCase() };
  }
  return { clusters:cluster?[cluster]:[], kams:[], zhs:[], creator:String(ctx.actualEmail||ctx.email||'').toLowerCase() };
}
function notificationAudienceAllows_(notif, ctx) {
  ctx = ctx || {}; notif = notif || {};
  if (ctx.isSuper) return true;
  var audience = notif.audience;
  // Legacy drive alerts can still be scoped from their saved drive. Other
  // unscoped legacy alerts fail closed except for their own creator.
  if (!audience && notif.driveId) {
    var drive = drivesAll_().filter(function(d){ return d.id === notif.driveId; })[0];
    if (drive) audience = notificationAudienceForDrive_(drive);
  }
  var email = String(ctx.email || ctx.actualEmail || '').trim().toLowerCase();
  if (!audience) return !!email && email === String(notif.createdBy||'').trim().toLowerCase();
  if (audience.all) return true;
  var cluster = clusterKey_(ctx.cluster || ''), clusters = audience.clusters || [];
  if (clusters.length && (!cluster || clusters.indexOf(cluster) === -1)) return false;
  if (String(ctx.role||'').toLowerCase() === 'ceo') return true;
  if (email === String(audience.creator || notif.createdBy || '').toLowerCase()) return true;
  var scopedKams = (audience.clusterKams && audience.clusterKams[cluster]) || audience.kams || [];
  var scopedZhs = (audience.clusterZhs && audience.clusterZhs[cluster]) || audience.zhs || [];
  if (String(ctx.role||'').toLowerCase() === 'kam') return scopedKams.indexOf(email) !== -1;
  if (String(ctx.role||'').toLowerCase() === 'zh') return scopedZhs.indexOf(email) !== -1;
  return false;
}
function notifCreate_(n) {
  var list = notifsAll_();
  var notif = {
    id: 'NTF' + Date.now() + Math.floor(Math.random() * 1000),
    type: n.type || 'custom',
    title: n.title || 'Notification',
    body: n.body || '',
    url: n.url || '',
    driveId: n.driveId || '',
    createdAt: new Date().toISOString(),
    createdBy: n.createdBy || '',
    expiresAt: n.expiresAt || (Date.now() + 21 * 86400000),
    audience: n.audience || null
  };
  list.unshift(notif);
  var now = Date.now();
  list = list.filter(function(x){ return !x.expiresAt || x.expiresAt > now; }).slice(0, 60);
  notifsSave_(list);
  return notif;
}

// User-facing: active notifications (newest first). Does NOT mark as viewed.
function getNotifications(viewer, clusterOverride) {
  setClusterOverride_(clusterOverride || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  var now = Date.now();
  var earliestVisible = now - NOTIF_USER_LOOKBACK_DAYS * 86400000;
  var out = notifsAll_()
    .filter(function(n){ return (!n.expiresAt || n.expiresAt > now) && Date.parse(n.createdAt || 0) >= earliestVisible && notificationAudienceAllows_(n, ctx); })
    .map(function(n){
      return { id:n.id, type:n.type, title:n.title, body:n.body, url:n.url,
               driveId:n.driveId || '', createdAt:n.createdAt };
    });
  return { status:'OK', notifications: out };
}

// Record that this viewer has now seen the given notification ids.
function markNotifViewed(ids, viewer, clusterOverride) {
  setClusterOverride_(clusterOverride || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  var email = String(ctx.email || '').toLowerCase();
  if (!email || !ids) return { status:'OK' };
  if (!Array.isArray(ids)) ids = [ids];
  var views = notifViewsAll_();
  var now = new Date().toISOString();
  var visible = {};
  notifsAll_().forEach(function(n){ if (notificationAudienceAllows_(n, ctx)) visible[n.id] = true; });
  ids.forEach(function(id){
    if (!id) return;
    if (!visible[id]) return;
    if (!views[id]) views[id] = {};
    if (!views[id][email]) views[id][email] = now;   // first-seen only
  });
  notifViewsSave_(views);
  return { status:'OK' };
}

// Admin: create a custom / reminder notification.
function sendNotification(payload, viewer, clusterOverride) {
  setClusterOverride_(clusterOverride || '');
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!canManageDrivesAndNotifs_(ctx)) return { status:'FORBIDDEN' };
  payload = payload || {};
  var body = String(payload.body || '').trim();
  if (!body) return { status:'NO_BODY' };
  var days = Number(payload.expiresDays || 14);
  if (!isFinite(days) || days <= 0) days = 14;
  notifCreate_({
    type: payload.type || 'custom',
    title: String(payload.title || '\uD83D\uDCE2 Announcement'),
    body: body,
    url: String(payload.url || ''),
    driveId: String(payload.driveId || ''),
    expiresAt: Date.now() + days * 86400000,
    createdBy: ctx.email || '', audience: notificationAudienceForContext_(ctx)
  });
  // CEO/ZH can send an update, but the restricted Drive & Notifications view
  // intentionally does not expose the organisation-wide notification history.
  var limitedRole = String(ctx.role || '').toLowerCase() === 'ceo' || String(ctx.role || '').toLowerCase() === 'zh';
  return { status:'OK', notifications: limitedRole ? [] : adminNotifList_() };
}

function deleteNotification(id, viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!ctx.isAdmin) return { status:'FORBIDDEN' };
  notifsSave_(notifsAll_().filter(function(n){ return n.id !== id; }));
  var views = notifViewsAll_(); delete views[id]; notifViewsSave_(views);
  return { status:'OK', notifications: adminNotifList_() };
}

// Admin: full notification list with view counts.
function adminNotifList_() {
  var views = notifViewsAll_();
  var now = Date.now();
  return notifsAll_().map(function(n){
    var v = views[n.id] || {};
    return { id:n.id, type:n.type, title:n.title, body:n.body, url:n.url,
             createdAt:n.createdAt, createdBy:n.createdBy,
             active: (!n.expiresAt || n.expiresAt > now),
             viewCount: Object.keys(v).length };
  });
}
function getAdminNotifications(viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!ctx.isAdmin) return { status:'FORBIDDEN', notifications: [] };
  return { status:'OK', notifications: adminNotifList_() };
}

// Admin: who has viewed a given notification.
function getNotifViews(notifId, viewer) {
  setViewer_(viewer);
  var ctx = getUserContext();
  if (!ctx.isAdmin) return { status:'FORBIDDEN', viewers: [] };
  var v = notifViewsAll_()[notifId] || {};
  var out = Object.keys(v).map(function(email){ return { email:email, name:email.split('@')[0], at:v[email] }; });
  out.sort(function(a,b){ return String(b.at || '').localeCompare(String(a.at || '')); });
  return { status:'OK', viewers: out, count: out.length };
}
