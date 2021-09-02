const Math = require('mathjs');
var pvInput = require( './forecast' ).pvInput;
const Alarms = require('./alarms').Alarms;
const logger = require('log4js').getLogger(); // getLogger('silent');

// FIXME: in all protection.js - make sure no unreported relay switching is done, i.e. must always log an alarm!!



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

        // const now = Date.now();
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
    constructor(id, name, config, actor) {
        this.id     = id * 100;
        this.name   = name
        this.config = config;
        this.alarm  = new Alarms();
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

        //console.log("sunset is in " + solarState.getSunset());
        // approx 2 hours before sunset or before the current into 
        // the battery becomes 0
        // FIXME: twoHousrTwentee can be removed once lastcurrenttime is properly calculated
        //        and working and the average load with relay on is known
        const twoHoursTwenteeInMS = 8400000; // (2 * 60 + 20) * 60 * 1000;
        const timeTillNullChargeInMS = lastCurrentTime - Date.now()
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
        if (!U) return; // there is no battery voltage of 0
        if (I === null || typeof I === 'undefined') return
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
    constructor(conf, actor) {
        super(actor);
        this.minDiffForCharge = conf.minDiffForCharge;
        this.minAccuVoltage = conf.minAccuVoltage;
    };

    setVoltages(topVoltage, bottomVoltage, pvVoltage) {
        return; // FIXME: temporary disabled as this will kick of the relay too often
        // bases on minAccuVoltage for a couple of seconds on high load. This needs
        // timing to be involved!!!
        if (topVoltage === null || typeof topVoltage === 'undefined') return;
        if (bottomVoltage === null || typeof bottomVoltage === 'undefined') return;
        if (pvVoltage === null || typeof pvVoltage === 'undefined') return;

        // logger.debug('BatteryProtection: ' + topVoltage);
        // logger.debug('BatteryProtection: ' + bottomVoltage);
        // logger.debug('BatteryProtection: ' + pvVoltage);

        try {
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
        catch(err) {
            logger.error('BatteryProtection::setVoltages failed: ' + err);
        }

    }
}


// Protection / Alarm if BMV alarm or MPPT alarming bits
class DeviceProtection {
    constructor(actor) { this.actor = actor; };

    removeLoad() {
        logger.debug("DeviceProtection::removeLoad"); // FIXME: revert to trace
        this.actor.setRelay(0);
    }

    // FIXME: it appears that two subsequent calls of switchload result in relay ON_OFF_ON behaviour
    switchLoad() {
        logger.debug("DeviceProtection::switchLoad"); // FIXME: revert to trace
        this.actor.setRelay(1);
    }
    
    // FIXME: add alarms
    setOverload(isOverload, time) {}; // if isOverload register alarm
    
    setShortcutLoad(isShortcut, time) {}; // if isShortcut register alarm

    setBatteryOverload(isOverload, time) {
        if (isOverload) {
            logger.debug("Battery overload detected by charger - removing load");
            this.removeLoad();
        }
    };

    setBatteryFull(isFull, time) {
        if (isFull) {
            logger.debug("Battery full detected by charger - switch on load");
            this.switchLoad();
        }
    };

    setOverDischarge(isOverDischarge, time) {
        if (isOverDischarge) {
            logger.debug("Battery discharged detected by charger - remove on load");
            this.removeLoad();
        }
    };

    // move to ChargerOverheatProtection
    setBatteryTemperature(temp, time) {}; // if temp > threshold register alarm

    setMonitorAlarm(alarm, time) {}; // if isShortcut register alarm
    setAlarmReason(reason, time) {}; // if isShortcut register alarm reason
}


// \class protection / alarm if PVvoltage above 32 and charging current <= 0
// \detail occassionally the Tracer 4215 RN gets into a mode with a high PV
//         voltage but the battery is still discharge. This naturally must
//         result heat production from the discharging battery and the
//         vapourization of the incoming PV energy.
class ChargerOverheatProtection {
    constructor(id, name, config, actor) {
        this.id     = id * 100;
        this.name   = name;
        this.config = config;
        this.alarm  = new Alarms();
        this.actor  = actor;
    }

    setFlow(flow) {
        if (! flow) return; // on null and undefined return
        let I = flow.getCurrent();
        let U = flow.getVoltage();
        if (! U) return; // there is no PV voltage of 0
        if (I === null || typeof I === 'undefined') return;
        let Istr = String(I) + "A";
        let Ustr = String(U) + "V";

        if (U >= this.config.maxVoltage && I <= this.config.whenCurrentBelow) {
            this.alarm.raise(this.id + 4, this.config.alarmLevel,
                             this.name + ": charger discharging; voltage " + Ustr +
                             " at " + Istr,
                             "Switching load on battery");
            // For now just raise the alarm. The MPPT charger needs to be reset.
            // There is no obvious command to reset the MPPT charger and for now
            // it has to be done manually by pulling all fuses to fully disconnect
            // the charger.
            // It is unclear whether switching on load would help.
            //FIXME not good: if (this.config.alarmLevel === 2) this.switchLoad();
        }
        else this.alarm.clear(this.id + 4, true);

        // negative PV current ==> electricity is pumped into PV
        if (I < 0) {
            this.alarm.raise(this.id + 4, this.config.alarmLevel,
                             this.name + ": charger discharging; voltage " + Ustr +
                             " at " + Istr,
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


module.exports.BatteryProtection = BatteryProtection;
module.exports.FlowProtection = FlowProtection;
module.exports.ChargerOverheatProtection = ChargerOverheatProtection;
module.exports.DeviceProtection = DeviceProtection;
