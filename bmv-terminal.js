//
// BMV
//

'use strict';

//****************************************************
// IMPORTS

// TODO ES6: import * as vedirect from 've_bms_forecast'
const Math = require('mathjs');
var term = require( 'terminal-kit' ).terminal;
const vedirect = require( './bms' ).BMSInstance;
var fs = require('fs');
var log4js = require('log4js');

//****************************************************
// LOGGING

const logger = log4js.getLogger('silent');


//****************************************************

var avgBaseCurrentLowVoltage = 660; // mA
var inverterBaseCurrent = 5590 - avgBaseCurrentLowVoltage; // mA

var bmvdata = {};

function startBMS() {
    try {
        console.log("trying to start vedirect");
        vedirect.start();
        console.log("success starting vedirect");
    }
    catch(err)
    {
        //logger.debug(err);
        console.log(err);
        console.log("deferring to start vedirect");
        setTimeout(startBMS, 2000)
    }
}
startBMS();

function terminate()
{
    term.grabInput( false ) ;
    setTimeout( function() { process.exit() } , 100 ) ;
}

term.clear();

function getShortDescr(key) {
    if (typeof bmvdata[key] !== 'undefined') return bmvdata[key].shortDescr + ':';
    return "";
}

function getFormatted(key) {
    if (typeof bmvdata[key] !== 'undefined') return bmvdata[key].formatted();
    return "";
}

function getFormattedWithUnit(key) {
    if (typeof bmvdata[key] !== 'undefined') return bmvdata[key].formattedWithUnit();
    return "";
}

function getValue(key) {
    if (typeof bmvdata[key] !== 'undefined') return bmvdata[key].value;
    return null;
}

function getStoredAh()
{
    if (getValue('absorbedEnergy') === null) return null;
    if (getValue('dischargeEnergy') === null) return null;
    // do not use formatted(); value yields in better precision
    let consumedAh = getValue('absorbedEnergy') - getValue('dischargeEnergy');
    consumedAh /= 2400; // multiply value by 0.01 to get kWh and divide by 24V to get Ah
    return consumedAh;
}

function getAccumulatedSOC(soc, deltaAhSinceLast)
{
    if (!getValue('capacity'))
    {
        logger.warn("getAccumulatedSOC: Capacity missing");
        return null;
    }
    if (soc === undefined)
    {
        logger.warn("getAccumulatedSOC: SOC missing");
        return null;
    }
    soc = soc * 0.01; // convert from % to float
    let lastAh = soc * getFormatted('capacity');
    let currentAh = lastAh + deltaAhSinceLast;
    let socNew = Math.max(Math.min(currentAh / getFormatted('capacity') * 100.0, 100.0), 0.0);
    if (deltaAhSinceLast != 0)
        logger.debug("deltaAhsincelast: " + deltaAhSinceLast
                     + "  soc: " + soc
                     + "  lastAH: " + lastAh
                     + "  currentAh: " + currentAh
                     + "  new soc: " + socNew);
    return socNew;
}

var lastTopSOC;
var lastBottomSOC;
var lastStoredAh;

function getBestEstimateTopSOC(current)
{
    let deltaAhSinceLast = getStoredAh();
    if (deltaAhSinceLast === null)
    {
        deltaAhSinceLast = lastStoredAh;
        logger.warn("Stored Ah not yet available");
    }
    let isAccumulating = true;
    // positive if the battery got charged, negative if it got discharged
    if (deltaAhSinceLast !== null && lastStoredAh !== null && lastStoredAh !== undefined)
        deltaAhSinceLast -= lastStoredAh;
    else
    {
        if (deltaAhSinceLast === null) logger.warn("deltaAhSinceLast is null");
        if (lastStoredAh === null) logger.warn("lastStoredAh is null");
        if (lastStoredAh === undefined) logger.warn("lastStoredAh is undefined");

        deltaAhSinceLast = 0;
        isAccumulating = false;
        logger.warn("Cannot accumulate");
    }
    if (deltaAhSinceLast != 0)
        logger.debug("lastTopSOC and deltaAhSinceLast = " + lastTopSOC + "  " + deltaAhSinceLast);
    let topSOC = getAccumulatedSOC(lastTopSOC, deltaAhSinceLast);
    logger.debug("topSOC = " + topSOC);
    let voltage = 1.955 * 6;
//    if (getValue('topVoltage') !== null) voltage = getFormatted('topVoltage');
    if (topSOC === null)
        topSOC = estimate_SOC(voltage);
    //logger.info("current: " + current + "  maxNullcurrentth: " + maxNullCurrentThreshold);
    if (Math.abs(current) < maxNullCurrentThreshold
        || lastTopSOC === undefined || lastStoredAh === undefined || lastStoredAh === null
        || topSOC === 0 || topSOC >= 100)
    {
        lastTopSOC = estimate_SOC(voltage);
        lastStoredAh = getStoredAh();
        if (isAccumulating && topSOC != lastTopSOC)
            logger.debug("diff between accumulated top SOC (" + topSOC + ") and null-current SOC ("
                     + lastTopSOC + ") is: " + (topSOC - lastTopSOC));
        topSOC = lastTopSOC;
    }
    return topSOC;
}
        
function getBestEstimateBottomSOC(current)
{
    let deltaAhSinceLast = getStoredAh();
    if (deltaAhSinceLast === null)
    {
        deltaAhSinceLast = lastStoredAh;
        logger.warn("Stored Ah not yet available");
    }
    let isAccumulating = true;
    // positive if the battery got charged, negative if it got discharged
    if (deltaAhSinceLast !== null && lastStoredAh !== null && lastStoredAh !== undefined)
        deltaAhSinceLast -= lastStoredAh;
    else
    {
        if (deltaAhSinceLast === null)      logger.warn("deltaAhSinceLast is null");
        if (lastStoredAh     === null)      logger.warn("lastStoredAh is null");
        if (lastStoredAh     === undefined) logger.warn("lastStoredAh is undefined");

        deltaAhSinceLast = 0;
        isAccumulating = false;
        logger.warn("Cannot accumulate");
    }
    let bottomSOC = getAccumulatedSOC(lastBottomSOC, deltaAhSinceLast)
    let voltage = 1.955 * 6;
    if (getValue('midVoltage') !== null) voltage = getFormatted('midVoltage');
    if (bottomSOC === null)
        bottomSOC = estimate_SOC(voltage);
    //logger.info("current: " + current + "  maxNullcurrentth: " + maxNullCurrentThreshold);
    if (Math.abs(current) < maxNullCurrentThreshold
        || lastBottomSOC === undefined || lastStoredAh === undefined || lastStoredAh === null
        || bottomSOC === 0 || bottomSOC >= 100)
    {
        lastBottomSOC = estimate_SOC(voltage);
        lastStoredAh = getStoredAh();
        if (isAccumulating && bottomSOC != lastBottomSOC)
            logger.debug("diff between accumulated bottom SOC (" + bottomSOC + ") and null-current SOC ("
                     + lastBottomSOC + ") is: " + (bottomSOC - lastBottomSOC));
        bottomSOC = lastBottomSOC;
    }
    return bottomSOC;
}
        
var menu1 = "(A)larm (B)oot (D)ownload Cfg (L)og current (P)ing (R)elay";
var menu2 = "(H)istory of alarms (M)PPT";
var menu3 = "(S)OC (T)oggle screen (U)pload Cfg (V)ersion (Ctrl-C) Exit";
var minSOC;

function displayAlarms() {
    term.clear();
    var v1 = 2;  // first vertical position
    var h  = 2;
    
    term.moveTo(v1, h++, "Alarm History:\n\n");
    //term.moveTo(v1, h, "%s", vedirect.listAlarms());
    console.log(vedirect.listAlarms());
}

function displayCurrentAndHistory() {
    var clearStr = "                                              ";
    var v1 = 2;  // first vertical position
    var v2 = 30; // second vertical position
    var v3 = 56; // third  vertical position
    var h  = 2;

    // TODO: slow ==> remove
    term.clear();

    term.moveTo(v1, h, "BMV type: ");
    term.brightBlue(getFormatted('productId'));
    term.moveTo(v2, h, "%s %f", getShortDescr('version'), getFormatted('version') );
    let d = new Date();
    term.moveTo(v3, h++, "Time: %s", d.toUTCString() );

    h++;
    term.moveTo(v1 , h,   clearStr) ;
    term.moveTo(v1,  h,   "%s ", getShortDescr('alarmState'));
    if (getValue('alarmState') === "OFF") {
        term.green(getValue('alarmState'));
    }
    else {
        term.brightRed(getValue('alarmState'));
    }
    term.moveTo(v2,  h,   "%s %s", getShortDescr('relayState'), getValue('relayState'));
    term.moveTo(v3 , h++, "Accu Alarm: (%d) ", getValue('alarmReason')) ;
    var alarmText = getFormatted('alarmReason');
    if (getValue('alarmReason') == 0) {
        term.green( alarmText ) ;
    } else {
        term.brightRed( alarmText ) ;
    } 

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v2, h,   "%s %s", getShortDescr('lowVoltageAlarms'), getFormattedWithUnit('lowVoltageAlarms'));
    term.moveTo(v3, h++, "%s %s", getShortDescr('highVoltageAlarms'), getFormattedWithUnit('highVoltageAlarms'));

    term.white.moveTo(v1, h, clearStr);
    term.moveTo(v1, h,   "%s %s", getShortDescr('minVoltage'), getFormattedWithUnit('minVoltage'));
    term.moveTo(v2, h, getShortDescr('upperVoltage') + " ") ;
    if (getValue('batteryCurrent') === 0) {
        term.blue( getFormattedWithUnit('upperVoltage') ) ;
    }
    if (getValue('batteryCurrent') < 0) {
        term.yellow( getFormattedWithUnit('upperVoltage') ) ;
    }
    if (getValue('batteryCurrent') > 0) {
        term.green( getFormattedWithUnit('upperVoltage') ) ;
    }
    term.moveTo(v3, h++, "%s %s", getShortDescr('maxVoltage'), getFormattedWithUnit('maxVoltage'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h,   "%s %s", getShortDescr('minAuxVoltage'), getFormattedWithUnit('minAuxVoltage'));

    term.moveTo(v2, h,   "%s %s   " , getShortDescr('midVoltage'), getFormattedWithUnit('midVoltage') ) ;

    term.moveTo(v3, h++, "%s %s", getShortDescr('maxAuxVoltage'), getFormattedWithUnit('maxAuxVoltage'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v2, h++, "%s %s   " , getShortDescr('topVoltage'), getFormattedWithUnit('topVoltage')) ;

    term.moveTo(v1, h, clearStr);

    let current = maxNullCurrentThreshold + 1;
    if (getValue('batteryCurrent') !== null && getValue('batteryCurrent') !== undefined)
        current = getFormatted('batteryCurrent');

    //let topSOC    = getBestEstimateTopSOC(current).toFixed(1);
    //let bottomSOC = getBestEstimateBottomSOC(current).toFixed(1);
    let topSOC    = vedirect.getLowerSOC();
    let bottomSOC = vedirect.getUpperSOC();

    try {
        if (topSOC && bottomSOC && (typeof topSOC === 'number') && (typeof bottomSOC === 'number'))
            minSOC = Math.min(topSOC, bottomSOC);
    }
    catch (err) {
        console.log(err);
        minSOC = 0;
    }
    if ((isNaN(getValue('stateOfCharge'))) || getValue('stateOfCharge') * 0.1 > 100
        || getValue('stateOfCharge') * 0.1 < 0)
        if (minSOC) vedirect.setStateOfCharge(minSOC);

    if (minSOC && Math.abs(getValue('stateOfCharge') * 0.1 - minSOC) >=1)
    {
        vedirect.setStateOfCharge(minSOC);
    }
    term.moveTo(v1, h,     "%s: %s %  " , "SOC lower", bottomSOC);
    term.moveTo(v2, h,     "SOC: %s  " , getFormattedWithUnit('stateOfCharge') ) ;
    term.moveTo(v3, h++,   "%s: %s %  " , "SOC top", topSOC);

    term.moveTo(v1, h, clearStr) ;
    term.moveTo(v2, h++, "%s %s", getShortDescr('midDeviation'), getFormattedWithUnit('midDeviation'));

    term.moveTo(v1, h, clearStr) ;
    term.moveTo(v1, h, "Current %s   " , getFormattedWithUnit('batteryCurrent') ) ;
    term.moveTo(v2, h++, "Power: %s", getFormattedWithUnit('instantPower'));

    //term.moveTo(v1, h, clearStr) ;
    //term.moveTo(v1, h++, "%s %s   " , getShortDescr('auxVolt'), getFormattedWithUnit('auxVolt') ) ;

    // bmvdata.VS, bmvdata.I2, bmvdata.V2, bmvdata.SOC2
    //term.moveTo( 24 ,16 , "                                "); 
    //term.moveTo( 24 ,16 , "Line: %s", bmvdata.line);

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h, "Dischg deep: %s", getFormattedWithUnit('deepestDischarge'));
    term.moveTo(v2, h, "last: %s", getFormattedWithUnit('maxAHsinceLastSync'));
    term.moveTo(v3, h++, "avg.: %s", getFormattedWithUnit('avgDischarge'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h, "%s %s", getShortDescr('chargeCycles'), getFormattedWithUnit('chargeCycles'));
    term.moveTo(v2, h, "%s %s", getShortDescr('fullDischarges'), getFormattedWithUnit('fullDischarges'));
    term.moveTo(v3, h++, "%s %s", getShortDescr('noAutoSyncs'), getFormattedWithUnit('noAutoSyncs'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h, "%s %s", getShortDescr('drawnAh'), getFormattedWithUnit('drawnAh'));
    term.moveTo(v2, h, "%s %s", getShortDescr('dischargeEnergy'), getFormattedWithUnit('dischargeEnergy'));
    term.moveTo(v3, h++, "%s %s", getShortDescr('absorbedEnergy'), getFormattedWithUnit('absorbedEnergy'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('consumedAh'), getFormattedWithUnit('consumedAh'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h,   "%s %s", getShortDescr('timeSinceFullCharge'), getFormattedWithUnit('timeSinceFullCharge'));
    term.moveTo(v3, h++, "%s %s", getShortDescr('timeToGo'), getFormattedWithUnit('timeToGo'));

    h++; // empty line
    term.moveTo(v1, h++, menu1);
    term.moveTo(v1, h++, menu2);
    term.moveTo(v1, h++, menu3);

    term.moveTo( 0 , 0 , "") ;
}

function displayConfiguration() {
    var clearStr = "                                              ";
    var v1 = 2;  // first vertical position
    var v2 = 30; // second vertical position
    var v3 = 56; // third  vertical position
    var h  = 2;

    // TODO: slow ==> remove
    term.clear();

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('capacity'), getFormattedWithUnit('capacity'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('chargedVoltage'), getFormattedWithUnit('chargedVoltage'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('tailCurrent'), getFormattedWithUnit('tailCurrent'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('chargedDetectTime'), getFormattedWithUnit('chargedDetectTime'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('peukertCoefficient'), getFormattedWithUnit('peukertCoefficient'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('currentThreshold'), getFormattedWithUnit('currentThreshold'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('timeToGoDelta'), getFormattedWithUnit('timeToGoDelta'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('relayLowSOC'), getFormattedWithUnit('relayLowSOC'));

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s %s", getShortDescr('relayLowSOCClear'), getFormattedWithUnit('relayLowSOCClear'));

    h++; // empty line
    term.moveTo(v1, h++, menu1);
    term.moveTo(v1, h++, menu2);
    term.moveTo(v1, h++, menu3);

    term.moveTo( 0 , 0 , "") ;
}


function displayMPPT() {
    var clearStr = "                                              ";
    var v1 = 2;  // first vertical position
    var v2 = 30; // second vertical position
    var v3 = 56; // third  vertical position
    var h  = 2;

    // TODO: slow ==> remove
    term.clear();

    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTbatteryVoltage'), getFormattedWithUnit('MPPTbatteryVoltage'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTpvVoltage'), getFormattedWithUnit('MPPTpvVoltage'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTchargingCurrent'), getFormattedWithUnit('MPPTchargingCurrent'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTloadCurrent'), getFormattedWithUnit('MPPTloadCurrent'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTbatteryTemperature'), getFormattedWithUnit('MPPTbatteryTemperature'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTisOverload'), getFormattedWithUnit('MPPTisOverload'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTisShortcutLoad'), getFormattedWithUnit('MPPTisShortcutLoad'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTisBatteryOverload'), getFormattedWithUnit('MPPTisBatteryOverload'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTisOverDischarge'), getFormattedWithUnit('MPPTisOverDischarge'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTisFullIndicator'), getFormattedWithUnit('MPPTisFullIndicator'));
    term.moveTo(v1, h++, "%s %s", getShortDescr('MPPTisCharging'), getFormattedWithUnit('MPPTisCharging'));

    h++; // empty line
    term.moveTo(v1, h++, menu1);
    term.moveTo(v1, h++, menu2);
    term.moveTo(v1, h++, menu3);

    term.moveTo( 0 , 0 , "") ;
}


// Dispersion parameter
class StatisticObject {
    constructor() {
        this.reset();
    }

    reset() {
        this.min = 32000;
        this.max = 0;
        this.runningAvg = 0;
        this.runningVar = 0;
        this.counter = 0;
    }

    // currents must be integer and in mA
    update(value) {
        var v = parseInt(value);
        this.min = Math.min(this.min, v);
        this.max = Math.max(this.max, v);
        this.runningAvg = v + this.runningAvg;
        this.counter++;
        var avg = Math.floor(this.runningAvg / this.counter);
        this.runningVar = this.runningVar + Math.square(v - avg);
    }
    
    print(log)
    {
        var minimum   = 0;
        var average   = 0;
        var varianz   = 0;
        if (this.counter != 0)
        {
            minimum   = this.min;
            average   = Math.floor(this.runningAvg / this.counter);
            varianz   = Math.floor(this.runningVar / this.counter);
        }
        log.write(
              minimum + '\t'
            + average  + '\t'
            + this.max + '\t'
            + varianz);
    }
}

var chargeCurrent = new StatisticObject();
var drawCurrent   = new StatisticObject();

var date = new Date();
var hour = date.getHours();
var current_log = fs.createWriteStream('/var/log/current.log', {flags: 'a'});

// time series
function log_buckets(current)
{
    var date = new Date();
    var newHour = date.getHours();
    if (newHour !== hour)
    {
        if (newHour == 0)
        {
           current_log.write(date.toLocaleString());
           current_log.write('\n');
        }
        current_log.write(hour + '\t');
        chargeCurrent.print(current_log);
        current_log.write('\t');
        drawCurrent.print(current_log);
        current_log.write('\n');
        chargeCurrent.reset();
        drawCurrent.reset();
    }
    hour = newHour;
    if (current >= 0)
    {
        chargeCurrent.update(current);
    }
    else
    {
        current = -current;
        drawCurrent.update(current);
    }
}


// input total current and lower or upper voltage of battery array (must be around 12V)


var nullCounter = 0;
var maxNullCurrentThreshold = 0.050; // in Ampere
function estimate_SOC(volt, current)
{
    let minCellVoltage=1.955; // V
    let maxCellVoltage=2.17; // V
    let SOC = undefined;
    if (current == undefined || Math.abs(current) < maxNullCurrentThreshold)
    {
        nullCounter++;
        if (current == undefined || nullCounter >= 5) // for 5 * 3 secs
        {
            volt = volt / 6.0;
            var diff = maxCellVoltage - minCellVoltage;
            SOC = Math.min(100.0, 100.0 * (volt - minCellVoltage) / diff);
            SOC = Math.max(0.0, SOC);
        }
    }
    else 
    {
        nullCounter = 0;
    }
    return SOC;
}

//var soc_log = fs.createWriteStream(__dirname + '/soc.log', {flags: 'a'});
var soc_log = fs.createWriteStream('/var/log/soc.log', {flags: 'a'});

var displayFunction = displayCurrentAndHistory;

var current_function_log = fs.createWriteStream('/var/log/current_plot.log', {flags: 'a'});
var currentListener = function(newCurrent, oldCurrent, precision, timestamp)
{
    var date = new Date();
    current_function_log.write(date.getTime() / 1000 + '\t' +  newCurrent + '\n');
}


var displayinterval = setInterval(function () {
    bmvdata = vedirect.update();
    displayFunction();
    let current       = getFormatted('batteryCurrent');
    let midVoltage    = getFormatted('midVoltage');
    let topVoltage    = 0; //getFormatted('topVoltage');
    log_buckets(getValue('batteryCurrent')); // current in mA
    let topSOC        = 0; //estimate_SOC(topVoltage, current);
    let bottomSOC     = estimate_SOC(midVoltage, current);
    // topSOC or bottomSOC being undefined means that the current is too high
    if (topSOC !== undefined && bottomSOC !== undefined)
    {
        topSOC    = Math.round(topSOC);
        bottomSOC = Math.round(bottomSOC);
        if (topSOC != lastTopSOC || bottomSOC != lastBottomSOC)
        {
            var date = new Date();
            //soc_log.write(date.toLocaleString('en-GB', { timeZone: 'UTC' }) + n'\t' + "top SOC: " + topSOC + '\t' + "bottom SOC: " + bottomSOC + '\n');
            soc_log.write(date.toLocaleString() + '\t'
                          + "current: " + current + '\t'
//                        + "top V: " +  topVoltage + '\t'
                          + "top SOC: " + topSOC
                          + " (" + (topSOC - lastTopSOC) + ")" + '\t'
                          + "bottom V: " + midVoltage + '\t'
                          + "bottom SOC: " + bottomSOC
                          + " (" + (bottomSOC - lastBottomSOC) + ")" + '\n');
            //lastTopSOC = topSOC;
            //lastBottomSOC = bottomSOC;
            //lastStoredAh = getStoredAh();
        }
    }
    //process.stdout.write(topSOC);
    //process.stdout.write(bottomSOC);
  }, 3000);


var readDeviceConfig = function()
{
    logger.trace("readDeviceConfig");
    const file = __dirname + '/config.json';
    fs.readFile(file, 'utf8', (err, data) => {
        if (err) {
            logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        } else {
            logger.debug("Parse configuration (JSON format)");
            let config = JSON.parse(data);
            vedirect.setBatteryCapacity(config.BatteryCapacity);
            vedirect.setChargedVoltage(config.ChargedVoltage);
            vedirect.setTailCurrent(config.TailCurrent);
            vedirect.setChargedDetectTime(config.ChargedDetectTime);
            vedirect.setChargeEfficiency(config.ChargeEfficiency);
            vedirect.setPeukertCoefficient(config.PeukertCoefficient);
            vedirect.setCurrentThreshold(config.CurrentThreshold);
            vedirect.setTimeToGoDelta(config.TimeToGoDelta);
            vedirect.setRelayLowSOC(config.RelayLowSOC);
            vedirect.setRelayLowSOCClear(config.RelayLowSOCClear);
        }
    });
}


var alarmOnOff = 0;

term.grabInput( { mouse: 'button' } ) ;

// other terminal event handlers:
// term.on( 'terminal' , ( name , data ) => { ... } );
// term.on( 'mouse' ,    ( name , data ) => { ... } );
term.on( 'key' , ( name , matches , data ) => {
    logger.debug( "'key' event:" + name + "; matches: " + matches);
    term.clear();

    if ( name === 'CTRL_C' ) {
        vedirect.stop();
        terminate() ;
    }
    name = name.toUpperCase()
    if ( name === 'R' )
    {
        term.clear();
        //term.moveto(20, 10);
        let relayOnOff = 0;
        if (getValue('relayState') !== "OFF") relayOnOff = 1;
        if (relayOnOff == 1) {
            term.green('Switch relay off');
            vedirect.setRelay(0);
        }
        else {
            term.green('Switch relay on');
            vedirect.setRelay(1);
        }
    }
    else if ( name === 'S' )
    {
        term.green('Set SOC ' + minSOC + ' %');
        vedirect.setStateOfCharge(minSOC);
    }
    else if ( name === 'P' )
    {
        term.green('Ping');
        vedirect.ping();
    }
    else if ( name === 'V' )
    {
        term.green('App Version');
        vedirect.app_version();
    }
    else if ( name === 'A' )
    {
        term.clear();
        //term.moveto(20, 10);
        // if (alarmOnOff == 0) {
             term.green('Alarm acknowledged');
             vedirect.clearAlarm();
        //     alarmOnOff = 1;
        // }
        // else {
        //     term.green('Switch alarm on');
        //     vedirect.setAlarm();
        //     alarmOnOff = 0;
        // }
    }
    else if ( name === 'B' )
    {
        term.red('Restarting');
        vedirect.restart();
    }
    else if ( name === 'D' )
    {
        term.yellow('Downloading configuration');
        vedirect.getDeviceConfig(true);
    }
    else if ( name === 'U' )
    {
        term.yellow('Uploading configuration');
        readDeviceConfig();
    }
    else if ( name === 'T' )
    {
        if (displayFunction !== displayCurrentAndHistory)
            displayFunction = displayCurrentAndHistory;
        else
            displayFunction = displayConfiguration;
    }
    else if ( name === 'M' )
    {
        displayFunction = displayMPPT;
    }
    else if ( name === 'H' )
    {
        displayFunction = displayAlarms;
    }
    else if ( name === 'L' )
    {
        if (vedirect.hasListeners('batteryCurrent'))
        {
            term.yellow('Stop Logging current');
            vedirect.registerListener('batteryCurrent', null);
        }
        else
        {
            term.yellow('Start Logging current');
            vedirect.registerListener('batteryCurrent', currentListener);
        }
    }
} ) ;

readDeviceConfig();

