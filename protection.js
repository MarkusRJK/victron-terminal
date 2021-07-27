var log4js = require('log4js');
const Math = require('mathjs');
var pvInput = require( './forecast' ).pvInput;
var fs = require('fs');

const file = __dirname + '/alarms.json';

//const logger = log4js.getLogger('silent');
const logger = log4js.getLogger();

const minutesToMS = 60 * 1000;

const cRed    = "\x1b[5m\x1b[1m\x1b[31m";
const cGreen  = "\x1b[1m\x1b[32m";
const cYellow = "\x1b[33m";
const cReset  = "\x1b[0m";

// singleton class Alarm
// TODO: implement new policy:
// low priority alarm:    alarm notification of possibly harmful state (no action)
// medium priority alarm: alarm notification with action
// high priority alarm:   alarm notification with possible action which
//                        requires use interference
class Alarm {
    constructor(historyLength, silenceInMinutes) {
        logger.trace('Alarm::constructor');
        if(! Alarm.instance){
            this.alarmHistory = [];
            this.readAlarms();
            this.actionLevel = 1;
            if (historyLength)
                this.historyLength = 20; // default
            else
                this.historyLength = historyLength;
            if (silenceInMinutes)
                this.silenceInMS = 5 * minutesToMS; // 5 minutes - in milliseconds
            else
                this.silenceInMS = silenceInMinutes * minutesToMS;
            Alarm.instance = this;
        }
        return Alarm.instance;
    }

    // \param level from which (incl.) on the action is performed
    setActionLevel(level) {
        this.actionLevel = level;
    }

    // try to reduce to historyLength, yet keep all active alarms
    reduce() {
        if (this.alarmHistory.length <= this.historyLength) return;
        let filteredHistory = this.alarmHistory.filter((a) => a.isActive);
        this.alarmHistory = filteredHistory;
    }

    writeAlarms() {
        logger.trace('EnergyAndChargeMeter::writeAlarms');
        let jData = JSON.stringify(this.alarmHistory);
        logger.info('Writing alarm file ' + file);
        let alarmFile = fs.createWriteStream(file, {flags: 'w'});
        alarmFile.write(jData);
    }

    readAlarms() {
        logger.trace('EnergyAndChargeMeter::readAlarms');

        try {
            let data = fs.readFileSync(file, 'utf8');
            this.alarmHistory = JSON.parse(data);
            logger.info('Alarms retrieved from ' + file);
        }
        catch (err) {
            logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        }
    }

    terminate() {
        this.writeAlarms();
    }

    formatAlarm(a, separator) {
        let levelTxt = '';

        if (!a.isActive) levelTxt = '(';
        switch (a.level) {
        case 0: levelTxt += 'low'; break;
        case 1: levelTxt += 'medium'; break;
        case 2: levelTxt += 'high'; break;
        }
        if (!a.isActive) levelTxt += ')';
        let t = new Date(a.time).toTimeString().substring(0,5);
        let action = a.action;
        if (a.level < this.actionLevel) action = '';
        let output = t + separator + levelTxt + separator + a.failure +
            separator + action + '\n';
        //if (a.isActive) {h
            switch(a.level) {
            case 1: return cYellow + output + cReset; break;
            case 2: return cRed + output + cReset; break;
            default: return output; break;
            }
        //}
        //return output;
    }

    // \param separator is ',' for CSV, default is tab
    persistPlain(separator) {
        if (! separator) separator = '\t';

        // see https://www.freecodecamp.org/news/javascript-array-of-objects-tutorial-how-to-create-update-and-loop-through-objects-using-js-array-methods/
        // hpAlarms = this.alarmHistory.filter(a => a.level === 2)
        // lpAlarms = this.alarmHistory.filter(a => a.level === 0)
        // activeAlarms = this.alarmHistory.filter(a => a.isActive === true)

        let output = "\n";
        for (let i = 0; i < this.alarmHistory.length; ++i)
            output += this.formatAlarm(this.alarmHistory[i], separator);
        if (this.alarmHistory.length === 0) return cGreen + "No alarms" + cReset;
        return output;
    }

    recentAlarm() {
        if (this.alarmHistory.length) return this.alarmHistory[0];
        else return null;
    }

    // TODO: higher level alarms of same ID deactivate previous lower prio alarms
    // TODO: an alarm condition has to be present for several seconds/minutes before an action
    //       is triggered
    // \return 1 if alarm was raised, otherwise 0 (if alarm was previously raised or within
    //           last 5 min
    raise(id, alevel, failureText, actionText, eventTime) {
        logger.trace('Alarm::raise(' + id + ', ' + alevel + ')');
        let now = new Date();
        if (! eventTime) eventTime = now;

        let activeUnacknAlarms = this.alarmHistory.filter((a) => (a.isActive && !a.isAckn));
        // if unacknowledged alarms of same id exist then return
        if (activeUnacknAlarms.some((a) => (a.id === id))) {
            //logger.info('Alarm ' + id + ' already entered');
            return 0; // already entered
        }
        const fiveMinInMs = 300000; // = 5 * 60 * 1000
        // if any alarm with same id has been recent (within the last 5 min then return
        if (this.alarmHistory.some((a) => (a.id === id && now - a.time <= fiveMinInMs))) {
            // FIXME: also consider time - if two alarms too close, ignore second
            logger.info('Alarm ' + id + ' entered within last 5 min');
            return 0; // already entered
        }
        let alarm = { time     : eventTime,
                      id       : id,
                      level    : alevel,
                      failure  : failureText,
                      action   : actionText,
                      isAckn   : false,
                      isActive : true,
                      isAudible: (alevel >= 1)
                    };
        this.alarmHistory.unshift(alarm);
        this.reduce();
        // log ALARMs as fatal so they are always in the log
        logger.fatal("ALARM: " + JSON.stringify(alarm));
        return 1;
    }

    acknowledge(id) {
        const e = this.alarmHistory.find((element) => element.id === id);
        if (e) e.isAckn = true;
    }

    // silence temporary for 5 minutes at any time
    silence(id) {
        const i = this.alarmHistory.findIndex((element) => element.id === id);
        if (i < 0 || i >= this.alarmHistory.length) return;
        this.alarmHistory[i].isAudible = false;
        setTimeout(function() {
            this.alarmHistory[i].isAudible = true;
        }.bind(this), this.silenceInMS);

    }

    // first acknowledge then clear
    clear(id, force) {
        logger.trace('Alarm::clear(' + id + ')');
        const i = this.alarmHistory.findIndex((element) => (element.id === id));
        if (i < 0 || i >= this.alarmHistory.length) return;
        if (force || this.alarmHistory[i].isAckn) {
            if (this.alarmHistory[i].isActive !== false)
                logger.fatal("ALARM cleared: " + JSON.stringify(this.alarmHistory[i]));
            this.alarmHistory[i].isActive  = false;
            this.alarmHistory[i].isAudible = false;
        }
    }

    isAnyAudible() {
        return this.alarmHistory.some(a => a.isAudible);
    }

    isAnyActive() {
        return this.alarmHistory.some(a => a.isActive);
    }
}



// FIXME: replace by controlled + monitored switcher
class Switcher {

    constructor(actor) {
        this.actor  = actor;
        this.sunsetTimer = null;
    }

    removeLoad() {
        logger.debug("Switcher::removeLoad"); // FIXME: revert to trace
        clearTimeout(this.sunsetTimer);
        this.sunsetTimer = null;
        this.actor.setRelay(0);
    }


    // FIXME: it appears that two subsequent calls of switchload result in relay ON_OFF_ON behaviour
    switchLoad() {
        logger.debug("FlowProtection::switchLoad"); // FIXME: revert to trace
        this.actor.setRelay(1);

        // let lastCurrentTime = 0;
        // if (!pvInput) pvInput = require( './forecast' ).pvInput;

        // lastCurrentTime = pvInput.latestCurrent();
        // logger.debug('lastcurrenttime: ' + new Date(lastCurrentTime).toTimeString());

        // const now = new Date();
        // //console.log("sunset is in " + solarState.getSunset());
        // // approx 2 hours before sunset or before the current into 
        // // the battery becomes 0
        // // FIXME: twoHousrTwentee can be removed once lastcurrenttime is properly calculated
        // //        and working and the average load with relay on is known
        // const twoHoursTwenteeInMS = 8400000; // (2 * 60 + 20) * 60 * 1000;
        // const timeTillNullChargeInMS = lastCurrentTime - now.getTime()
        //       - twoHoursTwenteeInMS;
        // logger.debug('timeTillNullChargeInMS: ' + new Date(timeTillNullChargeInMS).toTimeString());
        // // FIXME: a timer will "get lost" if the server is restarted while 
        // //        switched on. Better to use protection class and feed in sunset
        // //        among parameters current, voltages, soc...
        // // FIXME: also the timer seems not to work if set more than 24 hours in advance
        // this.sunsetTimer = setTimeout(this.removeLoad.bind(this), timeTillNullChargeInMS);
    }
}


// consumes the flow and checks for violation of safe conditions
class FlowProtection { // shall extends Switcher
    // \param config file in JSON containing Alarms and Protection settings
    // \param actor is the victron control
    constructor(id, name, config, alarm, actor) {
        this.id     = id * 100;
        this.name   = name
        this.config = config;
        this.alarm  = alarm;
        this.actor  = actor;
        this.sunsetTimer = null;
    }

    removeLoad() {
        logger.debug("FlowProtection::removeLoad"); // FIXME: revert to trace
        clearTimeout(this.sunsetTimer);
        this.sunsetTimer = null;
        this.actor.setRelay(0);
    }


    // FIXME: it appears that two subsequent calls of switchload result in relay ON_OFF_ON behaviour
    switchLoad() {
        logger.debug("FlowProtection::switchLoad"); // FIXME: revert to trace
        this.actor.setRelay(1);

        let lastCurrentTime = 0;
        if (!pvInput) pvInput = require( './forecast' ).pvInput;

        lastCurrentTime = pvInput.latestCurrent();
        logger.debug('lastcurrenttime: ' + new Date(lastCurrentTime).toTimeString());

        const now = new Date();
        //console.log("sunset is in " + solarState.getSunset());
        // approx 2 hours before sunset or before the current into 
        // the battery becomes 0
        // FIXME: twoHousrTwentee can be removed once lastcurrenttime is properly calculated
        //        and working and the average load with relay on is known
        const twoHoursTwenteeInMS = 8400000; // (2 * 60 + 20) * 60 * 1000;
        const timeTillNullChargeInMS = lastCurrentTime - now.getTime()
              - twoHoursTwenteeInMS;
        logger.debug('timeTillNullChargeInMS: ' + new Date(timeTillNullChargeInMS).toTimeString());
        // FIXME: a timer will "get lost" if the server is restarted while 
        //        switched on. Better to use protection class and feed in sunset
        //        among parameters current, voltages, soc...
        // FIXME: also the timer seems not to work if set more than 24 hours in advance
        this.sunsetTimer = setTimeout(this.removeLoad.bind(this), timeTillNullChargeInMS);
    }
    
    // TODO: a failure condition prevail for a minimum time of e.g. 1 minute to raise an alarm
    setFlow(flow) {
        if (! flow) return; // on null and undefined return
        let I = flow.getCurrent();
        let U = flow.getVoltage();
        if (U === 0) return; // there is no battery voltage of 0
        let Istr = I.toFixed(2) + "A";
        let Ustr = U.toFixed(2) + "V";

        if (I <= this.config.absMinCurrent) {
            let isRaised = this.alarm.raise(this.id + 0, this.config.alarmLevel,
                             this.name + ": too much load " + Istr,
                             "Removing load from battery");
            // FIXME: to be integer put action text only if alarmLevel === 2
            if (this.config.alarmLevel >= 1 && isRaised) this.removeLoad();
        }
        else if (I > this.config.absMinCurrent * 1.05) {
            this.alarm.clear(this.id + 0, true);
        }

        if (I >= this.config.absMaxCurrent) {
            let isRaised = this.alarm.raise(this.id + 1, this.config.alarmLevel,
                             this.name + ": high charge current " + Istr,
                             "Switching load on battery");
            if (this.config.alarmLevel >= 1 && isRaised) this.switchLoad();
        }
        else if (I < this.config.absMaxCurrent * 0.95) {
            this.alarm.clear(this.id + 1, true);
        }
        
        // FIXME: correct config values when read from file instead of Math.abs here
        if (U <= this.config.minVoltage &&
            I >= 0 &&
            I <= Math.abs(this.config.whenCurrentBelow)) {
            let isRaised = this.alarm.raise(this.id + 2, this.config.alarmLevel,
                             this.name + ": battery capacity too low; voltage drop to " + Ustr + " for small current " + Istr,
                             "Removing load from battery");
            if (this.config.alarmLevel >= 1 && isRaised) this.removeLoad();
        }
        else if (U > this.config.minVoltage * 1.05 &&
                 I > Math.abs(this.config.whenCurrentBelow) * 1.05) {
            this.alarm.clear(this.id + 2, true);
        }

        if (U >= this.config.maxVoltage && I >= Math.abs(this.config.whenCurrentAbove)) {
            let isRaised = this.alarm.raise(this.id + 3, this.config.alarmLevel,
                             this.name + ": battery capacity too high; voltage " + Ustr + " and charging at " + Istr,
                             "Switching load on battery");
            if (this.config.alarmLevel >= 1 && isRaised) this.switchLoad();
        }
        else if (U < this.config.maxVoltage * 0.95 &&
                 I >= 0 &&
                 I < Math.abs(this.config.whenCurrentAbove) * 0.95) {
            this.alarm.clear(this.id + 3, true);
        }
    }
}

class BatteryProtection extends Switcher {
    constructor(actor) {
        super(actor);
        this.minDiffForCharge = 1.0;
        this.minAccuVoltage = 12.0;// FIXME: make configurable!!!
    };

    setVoltages(topVoltage, bottomVoltage, pvVoltage) {
        // logger.debug('BatteryProtection: ' + topVoltage);
        // logger.debug('BatteryProtection: ' + bottomVoltage);
        // logger.debug('BatteryProtection: ' + pvVoltage);
        // FIXME: add alarms
        if (topVoltage + bottomVoltage >= pvVoltage + this.minDiffForCharge) {
            // FIXME: does not allow to switch at night (switches back immediately)
            // use a mask flag that can be set when relay is switches manually
            //this.actor.setRelay(0);
        }
        if (topVoltage < this.minAccuVoltage) {
            this.actor.setRelay(0);
        }
        if (bottomVoltage < this.minAccuVoltage) {
            this.actor.setRelay(0);
        }
    }
}


// Protection / Alarm if BMV alarm or MPPT alarming bits
class DeviceProtection {
    constructor() {};

    setOverload() {};
    clearOverload() {};
    
    setShortcutLoad() {};
    clearShortcutLoad() {};

    setBatteryOverload() {};
    clearBatteryOverload() {};

    setOverDischarge() {};
    clearOverDischarge() {};

    //setBatteryTemperature() {};

    setBMVAlarm() {};
}


// \class protection / alarm if PVvoltage above 32 and charging current <= 0
// \detail occassionally the Tracer 4215 RN gets into a mode with a high PV
//         voltage but the battery is still discharge. This naturally must
//         result heat production from the discharging battery and the
//         vapourization of the incoming PV energy.
class ChargerOverheatProtection {
    constructor(id, name, config, alarm, actor) {
        this.id     = id * 100;
        this.name   = name;
        this.config = config;
        this.alarm  = alarm;
        this.actor  = actor;
    }

    setFlow(flow) {
        if (! flow) return; // on null and undefined return
        let I = flow.getCurrent();
        let U = flow.getVoltage();
        if (U === 0) return; // there is no PV voltage of 0
        let Istr = String(I) + "A";
        let Ustr = String(U) + "V";

        if (U >= this.config.maxVoltage && I <= this.config.whenCurrentBelow) {
            this.alarm.raise(this.id + 4, this.config.alarmLevel,
                             this.name + ": charger discharging; voltage " + Ustr +
                             " and charging at " + Istr,
                             "Switching load on battery");
            // For now just raise the alarm. The MPPT charger needs to be reset.
            // There is no obvious command to reset the MPPT charger and for now
            // it has to be done manually by pulling all fuses to fully disconnect
            // the charger.
            // It is unclear whether switching on load would help.
            //FIXME not good: if (this.config.alarmLevel === 2) this.switchLoad();
        }
        else this.alarm.clear(this.id + 4, true);
    }
}


module.exports.Alarm = Alarm;
module.exports.BatteryProtection = BatteryProtection;
module.exports.FlowProtection = FlowProtection;
module.exports.ChargerOverheatProtection = ChargerOverheatProtection;
