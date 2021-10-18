const Math = require('mathjs');
var pvInput = require( './forecast' ).pvInput;
const alarm = require('./alarms').Alarms;
const logger = require('log4js').getLogger(); // getLogger('silent');

// FIXME: in all protection.js - make sure no unreported relay switching is done, i.e. must always log an alarm!!


// \brief generic Monitor implementation to handle timings for raising alarms
// \details executes a callback if a state of alarm has perceived for
//        a certain time (durationActiveInS) and allows for a blackout of this
//        alarm after an alarm has happened.
class Monitor {
    // \param durationActiveInS is the time how long a monitored state has to be active
    //        continously without clearance to be considered for an alarm
    // \param blackoutInS time after a Monitor timeout activated (optional)
    constructor(durationActiveInS, blackoutInS) {
        this.durationActive = durationActiveInS * 1000; // to milliseconds
        // FIXME: what makes sense for blackout: from start of alarm or
        //        clearance of alarm?
        this.blackout = (blackoutInS && blackoutInS > 0 ? blackoutInS * 1000 : 0);
        this.timer = null;
        this.func = null;
    }
    // \param func is a function or an array of functions to call
    //        after continous activation for durationActive
    setActive(func) {
        if (!this.isActive()) {
            this.func = func;
            this.timer = setTimeout(this.wrapFunction.bind(this), this.durationActive);
            logger.debug("Monitor::setActive timer activated");
        }
        // else logger.debug("Monitor::setActive - blocked, timer already activated");
    }
    isActive() {
        return this.timer
    }
    getActiveTime() { return this.durationActive * 0.001; }
    setBlackout(blackoutInMs) {
        this.blackout = blackoutInMs;
    }
    startBlackout(blackoutInMs) {
        blackoutInMs = (blackoutInMs === null || typeof blackoutInMs === 'undefined'
                        ? this.blackout : blackoutInMs);
        if (blackoutInMs > 0) {
            this.func = null; // set to null so the second wrap call does not enter
            this.timer = setTimeout(this.wrapFunction.bind(this), blackoutInMs);
        }
        // else
        //     this.timer = null;
    }
    wrapFunction() {
        logger.debug("Monitor::wrapFunction"); // FIXME: ==> .trace
        try {
            if (this.func) {
		// if (length in this.func) // is an array
		//     this.func.map((f, idx) => { f(); });
		// else
                    this.func();
                this.startBlackout();
            }
            // else // leave this to clearActive
            //     this.timer = null;
        }
        catch(err) {
            logger.error(`Monitor::wrapFunction: ${err}`);
        }
    }
    // \brief typically called when monitored state clears
    clearActive() {
        //logger.debug("Monitor::clearActive");
        if (this.timer && this.func !== null) {
            logger.debug("Monitor::clearActive - timer cleared");
            clearTimeout(this.timer);
            this.timer = null;
            this.func = null;
        }        
    }    
}


var fs = require('fs');
var testdata = null;
function injectionTest() {
    try {
        //console.log("TESTING");
        //console.log(fs.readFileSync("/tmp/bmvtest", 'utf8'));
        testdata = JSON.parse(fs.readFileSync("/tmp/bmvtest", 'utf8'));
        //console.log(testdata);
        return true;
    }
    catch (err) {
        testdata = null;
        return false;
    }
}

 
// TODO: if the current is very high and suddenly there is no usage ==> inverter overlaod
//       ==> alarmlevel 2 alarm
// consumes the flow and checks for violation of safe conditions
class FlowProtection { // use Switcher instead of actuator
    // \param config file in JSON containing Alarms and Protection settings
    // \param actuator is the victron control
    constructor(id, name, config, actuator) {
        this.id     = id * 100;
        this.name   = name
        this.config = config;
        this.actuator  = actuator;
        this.minCurrentMonitor = new Monitor(config.durationActive); 
        this.maxCurrentMonitor = new Monitor(config.durationActive); 
        this.lowCapacityMonitor = new Monitor(config.durationActive);
        this.highCapacityMonitor = new Monitor(config.durationActive);
        
        this.sunsetTimer = null;
    }

    alarmAndRemoveLoad(alarmStr, alarmLevel, incr) {
        if (alarmLevel >= 1) {
            alarmStr += " load OFF";
            if (! injectionTest())
                this.actuator.removeLoad();
        }
        alarm.raise(this.id + incr, alarmLevel, alarmStr);
    }

    alarmAndSwitchLoad(alarmStr, alarmLevel, incr) {
        if (alarmLevel >= 1) {
            alarmStr += " load ON";
            if (! injectionTest())
                this.actuator.switchLoad();
        }
        alarm.raise(this.id + incr, alarmLevel, alarmStr);
    }

    setFlow(flow) {
        logger.trace("FlowProtection::setFlow");
        if (! flow) return; // on null and undefined return
        let I = flow.getCurrent();
        let U = flow.getVoltage();
        if (injectionTest()) {
            if ('FlowProtection' in testdata) {
                U = testdata.FlowProtection.U;
                I = testdata.FlowProtection.I;
                //console.log("FlowProtection - testing: U = " + U + ", I = " + I);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (!U) return; // there is no battery voltage of 0
        if (I === null || typeof I === 'undefined') return
        let Istr = I.toFixed(2) + "A";
        let Ustr = U.toFixed(2) + "V";

        if (I <= this.config.absMinCurrent) {
            let alarmStr = this.name + ": inverter overcurrent (" + Istr + ", "
                + this.minCurrentMonitor.getActiveTime() + "s)";
            this.minCurrentMonitor.setActive(this.alarmAndRemoveLoad.bind(this, alarmStr, this.config.alarmLevel, 0));
        }
        else {
            this.minCurrentMonitor.clearActive();
            alarm.clear(this.id + 0, true);
        }

        if (I >= this.config.absMaxCurrent) {
            let alarmStr = this.name + ": charge overcurrent (" + Istr + ", "
                + this.maxCurrentMonitor.getActiveTime() + "s)";
            this.maxCurrentMonitor.setActive(this.alarmAndSwitchLoad.bind(this, alarmStr, this.config.alarmLevel, 1));
        }
        else {
            this.maxCurrentMonitor.clearActive();
            alarm.clear(this.id + 1, true);
        }

        // FIXME: correct config values when read from file instead of Math.abs here
        if (U <= this.config.minVoltage &&
            I > 0 &&
            I <= Math.abs(this.config.whenCurrentBelow)) { // FIXME should the current not be negative???
            // a voltage drop for a small positive (negative????) current (battery 
            let alarmStr = this.name + ": capacity low (" + Ustr + ", " + Istr + ", "
                + this.lowCapacityMonitor.getActiveTime() + "s)";
            this.lowCapacityMonitor.setActive(this.alarmAndRemoveLoad.bind(this, alarmStr, this.config.alarmLevel, 2));
        }
        else {
            this.lowCapacityMonitor.clearActive();
            alarm.clear(this.id + 2, true);
        }

        if (U >= this.config.maxVoltage && I >= Math.abs(this.config.whenCurrentAbove)) {
            let alarmStr = this.name + ": capacity high (" + Ustr + ", " + Istr + ", "
                + this.highCapacityMonitor.getActiveTime() + "s)";
            this.highCapacityMonitor.setActive(this.alarmAndSwitchLoad.bind(this, alarmStr, this.config.alarmLevel, 3));
        }
        else {
            this.highCapacityMonitor.clearActive();
            alarm.clear(this.id + 3, true);
        }
    }
}

class BatteryProtection {

    constructor(id, name, config, actuator) {
        // FIXME: put id into config
        this.id = id * 100;
        this.name = name;
        this.actuator = actuator;
        this.config = config;
        this.maxVoltDiff = config.maxVoltDiff;
        this.minDiffForCharge = config.minDiffForCharge;
        this.minAccuVoltage = config.minAccuVoltage;
        this.maxAccuVoltage = config.maxAccuVoltage;
        this.topMonitor = new Monitor(config.durationActive); 
        this.bottomMonitor = new Monitor(config.durationActive);
        this.diffMonitor = new Monitor(config.durationActive);
        this.nightMonitor = new Monitor(0);
        this.allowDischargeAtNight = false;
    };

    allowDischargeAtNight(v) {
        this.allowDischargeAtNight = v;
    }

    voltageLow(alarmStr, alarmLevel, incr) {
        // For now just raise the alarm. The MPPT charger needs to be reset.
        // There is no obvious command to reset the MPPT charger and for now
        // it has to be done manually by pulling all fuses to fully disconnect
        // the charger.
        // Remove load until alarm is solved by disconnecting the MPPT charger.
        // This prevents discharge of batteries.
        if (alarmLevel >= 1) {
            alarmStr += " load OFF";
            if (! injectionTest())
                this.actuator.removeLoad();
        }
        alarm.raise(this.id + incr, alarmLevel, alarmStr);
    }

    alarmAndRemoveLoad(alarmStr, alarmLevel, incr) {
        if (alarmLevel >= 1) {
            alarmStr += " load OFF";
            if (! injectionTest())
                this.actuator.removeLoad();
        }
        alarm.raise(this.id + incr, alarmLevel, alarmStr);
    }

    unbalancedHigh(alarmStr, alarmLevel, incr) {
        if (alarmLevel >= 1) {
            alarmStr += " load ON";
            if (! injectionTest())
                this.actuator.switchLoad();
        }
        alarm.raise(this.id + incr, alarmLevel, alarmStr);

    }

    setVoltages(topVoltage, bottomVoltage, pvVoltage) {
        logger.trace("BatteryProtection::setVoltages");
        if (injectionTest()) {
            if ('BatteryProtection' in testdata) {
                topVoltage = testdata.BatteryProtection.topVoltage;
                bottomVoltage = testdata.BatteryProtection.bottomVoltage;
                pvVoltage = testdata.BatteryProtection.pvVoltage;
                console.log("BatteryProtection - testing: topVoltage = " + topVoltage
                    + ", bottomVoltage = " + bottomVoltage
                    + ", pvVoltage = " + pvVoltage);
            }
            else return; // for better testing exclude protection classes w/o injection
        }

        if (topVoltage === null || typeof topVoltage === 'undefined') return;
        if (bottomVoltage === null || typeof bottomVoltage === 'undefined') return;
        if (pvVoltage === null || typeof pvVoltage === 'undefined') return;

        // logger.debug('BatteryProtection: ' + topVoltage);
        // logger.debug('BatteryProtection: ' + bottomVoltage);
        // logger.debug('BatteryProtection: ' + pvVoltage);

        try {
            // pvVoltage must be higher than the sum of top and bottom.
            // Otherwise the accus cannot be charged. If for a longer time
            // the pvVoltage is below the sum of top and bottom, the night has come.
            if (! this.allowDischargeAtNight && this.actuator.isLoadOn()) {
                if (topVoltage + bottomVoltage + this.minDiffForCharge >= pvVoltage) {
                    let alarmStr = this.name + ": night time ("
                        + (topVoltage+bottomVoltage) + "V, "
                        + pvVoltage + "V, "
                        + this.topMonitor.getActiveTime() + "s)";
                    this.nightMonitor.setActive(this.alarmAndRemoveLoad.bind(this, alarmStr, this.config.alarmLevel, 1));
                }
                else {
                    this.nightMonitor.clearActive();
                    alarm.clear(this.id + 1, true);
                }
            }
            // top accu close to empty
            if (topVoltage < this.minAccuVoltage) {
                let alarmLevel = this.config.alarmLevel;
                if (!this.actuator.isLoadOn())
                    ++alarmLevel; // increase level for sound if load cannot be removed
                let alarmStr = this.name + ": top voltage low ("
                    + topVoltage + "V, "
                    + this.topMonitor.getActiveTime() + "s)";
                this.topMonitor.setActive(this.voltageLow.bind(this, alarmStr, alarmLevel, 2));
            }
            else {
                this.topMonitor.clearActive();
                alarm.clear(this.id + 2, true);
            }
            // top accu close to empty
            if (bottomVoltage < this.minAccuVoltage) {
                let alarmLevel = this.config.alarmLevel;
                if (!this.actuator.isLoadOn())
                    ++alarmLevel; // increase level for sound if load cannot be removed
                let alarmStr = this.name + ": bottom voltage low ("
                    + bottomVoltage + "V, "
                    + this.bottomMonitor.getActiveTime() + "s)";
                this.bottomMonitor.setActive(this.voltageLow.bind(this, alarmStr, alarmLevel, 3));
            }
            else {
                this.bottomMonitor.clearActive();
                alarm.clear(this.id + 3, true);
            }
            // If difference is to big for a longer time then the battery balancer
            // has to transfer too much current and may damage.
            // Mitigation: if one voltage is too low, remove the load
            //             if one voltage is too high, switch the load on
            if (Math.abs(bottomVoltage - topVoltage) > this.maxVoltDiff) {
                if (Math.min(bottomVoltage, topVoltage) < this.minAccuVoltage)
                {
                    let alarmLevel = this.config.alarmLevel;
                    if (!this.actuator.isLoadOn())
                        ++alarmLevel; // increase level for sound if load cannot be removed
                    let alarmStr = this.name + ": Unbalanced accus ("
                        + bottomVoltage + "V, " + topVoltage + "V, "+ this.diffMonitor.getActiveTime() + "s)";
                    this.diffMonitor.setActive(this.alarmAndRemoveLoad.bind(this, alarmStr, alarmLevel, 4));
                }
                else if (Math.max(bottomVoltage, topVoltage) > this.maxAccuVoltage) 
                {
                    let alarmLevel = this.config.alarmLevel;
                    if (this.actuator.isLoadOn())
                        ++alarmLevel; // increase level for sound if load is already on
                    let alarmStr = this.name + ": Unbalanced accus ("
                        + bottomVoltage + "V, " + topVoltage + "V, "+ this.diffMonitor.getActiveTime() + "s)";
                    this.diffMonitor.setActive(this.unbalancedHigh.bind(this, alarmStr, alarmLevel, 4));
                }
                else // record unbalanced in log
                {
                    let alarmStr = this.name + ": Unbalanced accus ("
                        + bottomVoltage + "V, " + topVoltage + "V, "+ this.diffMonitor.getActiveTime() + "s)";
                    this.diffMonitor.setActive(alarm.raise.bind(alarm, this.id + 4, 0, alarmStr));
                }
            }
            else {
                this.diffMonitor.clearActive();
                alarm.clear(this.id + 4, true);
            }
        }
        catch(err) {
            logger.error('BatteryProtection::setVoltages failed: ' + err);
        }

    }
}


// Protection / Alarm if BMV alarm or MPPT alarming bits
class DeviceProtection {
    constructor(name, config, actuator) {
        this.id = config.id;
        this.name = name;
        this.actuator = actuator;
        this.maxTemp = config.maxTemp;
        // no waiting time for overload, shortcuts...
        this.overloadMonitor = new Monitor(0);
        this.shortcutMonitor = new Monitor(0);
        this.battOverloadMonitor = new Monitor(0);
        this.fullChargeMonitor = new Monitor(config.timeIsFull);
        this.dischargeMonitor = new Monitor(0);
        this.tempMonitor = new Monitor(0);
        this.bmvAlarmMonitor = new Monitor(0, 300); // 5min blackout
    };

    // Overload is a serious condition and no waiting is applied.
    // It is expected that the MPPT charger itself takes corrective actions.
    // Otherwise manual intervention is necessary and hence alarm level is 2
    // (audio alarm).
    setOverload(isOverload, time) { // if isOverload register alarm
        logger.debug("DeviceProtection::setOverload");
        if (injectionTest()) {
            console.log("in DeviceProtection");
            if ('DeviceProtection' in testdata) {
                console.log('overload detected');
                isOverload = testdata.DeviceProtection.overload;
                console.log("DeviceProtection - testing: isOverload = " + isOverload);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (isOverload) {
            // FIXME: can (U, I) be added?
            let alarmStr = this.name + ": MPPT overload";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // to remove the overload:
            this.overloadMonitor.setActive(alarm.raise.bind(alarm, this.id + 1, 2, alarmStr));
        }
        else {
            this.overloadMonitor.clearActive();
            alarm.clear(this.id + 1, true);
        }
    };
    
    // Shortcut is a serious condition and no waiting is applied.
    // It is expected that the MPPT charger itself takes corrective actions.
    // Otherwise manual intervention is necessary and hence alarm level is 2
    // (audio alarm).
    setShortcutLoad(isShortcut, time) { // if isShortcut register alarm
        logger.debug("DeviceProtection::setShortcutLoad");
        if (injectionTest()) {
            if ('DeviceProtection' in testdata) {
                isShortcut = testdata.DeviceProtection.shortcutLoad;
                //console.log("DeviceProtection - testing: isShortcut = " + isShortcut);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (isShortcut) {
            // FIXME: can (U, I) be added?
            let alarmStr = this.name + ": MPPT shortcut";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // to remove the shortcut:
            this.shortcutMonitor.setActive(alarm.raise.bind(alarm, this.id + 2, 2, alarmStr));
        }
        else {
            this.shortcutMonitor.clearActive();
            alarm.clear(this.id + 2, true);
        }
    }

    // BatteryOverload is an unspecified condition.
    // It is expected that the MPPT charger itself takes corrective actions.
    // Otherwise manual intervention is necessary and hence alarm level is 2
    // (audio alarm).
    setBatteryOverload(isOverload, time) {
        logger.debug("DeviceProtection::setBatteryOverload");
        if (injectionTest()) {
            if ('DeviceProtection' in testdata) {
                isOverload = testdata.DeviceProtection.batteryOverload;
                console.log("DeviceProtection - testing: isOverload = " + isOverload);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (isOverload) {
            // FIXME: can (U, I) be added?
            let alarmStr = this.name + ": MPPT battery overload";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // to remove the overload:
            this.battOverloadMonitor.setActive(alarm.raise.bind(alarm, this.id + 3, 2, alarmStr));
        }
        else {
            this.battOverloadMonitor.clearActive();
            alarm.clear(this.id + 3, true);
        }
    };

    // Actions to be performed if battery is full. Act by switching load but do not
    // perform an audio alarm.
    batteryFull() {
        let alarmStr = this.name + ": MPPT full";
        alarm.raise(this.id + 4, 1, alarmStr);
        //logger.debug("Battery full detected by charger - switch on load");
        if (! injectionTest())
           this.actuator.switchLoad();
    }

    // If the MPPT full indicator is on for a long enough time, we
    // assume the battery is full.
    setBatteryFull(isFull, time) {
        logger.debug("DeviceProtection::setBatteryFull");
        if (injectionTest()) {
            if ('DeviceProtection' in testdata) {
                isFull = testdata.DeviceProtection.batteryFull;
                //console.log("DeviceProtection - testing: isFull = " + isFull);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (isFull) {
            let alarmStr = this.name + ": Battery full";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // to remove the overload:
            this.fullChargeMonitor.setActive(this.batteryFull.bind(this));
        }
        else {
            this.fullChargeMonitor.clearActive();
            alarm.clear(this.id + 4, true);
        }
    };

    // OverDischarge is a serious condition and no waiting is applied.
    // It is expected that the MPPT charger itself takes corrective actions.
    // Otherwise manual intervention is necessary and hence alarm level is 2
    // (audio alarm).
    setOverDischarge(isOverDischarge, time) {
        logger.debug("DeviceProtection::isOverDischarge");
        if (injectionTest()) {
            if ('DeviceProtection' in testdata) {
                isOverDischarge = testdata.DeviceProtection.overDischarge;
                //console.log("DeviceProtection - testing: isOverDischarge = " + isOverDischarge);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (isOverDischarge) {
            let alarmStr = this.name + ": MPPT over discharge";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // to remove the overload. This is the load on MPPT which cannot be
            // switched at this time (FIXME: implement)
            this.dischargeMonitor.setActive(alarm.raise.bind(alarm, this.id + 5, 2, alarmStr));
        }
        else {
            this.dischargeMonitor.clearActive();
            alarm.clear(this.id + 5, true);
        }
    };

    // FIXME: move to ChargerOverheatProtection
    // Too high BatteryTemperature is a non-serious condition and no waiting is applied.
    // It actually is not the battery temperature but the temperature of the MPPT.
    // The battery temperature is assumed to be similar.
    // Manual intervention is necessary (e.g. open door for ventilation) and hence alarm
    // level is 2 (audio alarm).
    setBatteryTemperature(temp, time) { // if temp > threshold register alarm
        logger.trace("DeviceProtection::setBatteryTemperature");
        if (injectionTest()) {
            if ('DeviceProtection' in testdata) {
                temp = testdata.DeviceProtection.batteryTempInC;
                //console.log("DeviceProtection - testing: temp = " + temp);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (temp > this.maxTemp) {
            let alarmStr = this.name + ": MPPT overheated (" + temp + "°C)";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // like venting. 
            this.tempMonitor.setActive(alarm.raise.bind(alarm, this.id + 6, 2, alarmStr));
        }
        else {
            this.tempMonitor.clearActive();
            alarm.clear(this.id + 6, true);
        }
    }

    // all alarms from BMV are low level.
    setMonitorAlarm(alarmState, alarmReason, time) {
        logger.trace("DeviceProtection::setMonitorAlarm");
        if (injectionTest()) {
            if ('DeviceProtection' in testdata) {
                alarmState = testdata.DeviceProtection.alarmState;
                alarmReason = testdata.DeviceProtection.alarmReason;
                //console.log("DeviceProtection - testing: temp = " + temp);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (alarmState !== 'OFF') {
            let alarmStr = this.name + ": Monitor Alarm";
            if (alarmReason && typeof alarmReason === 'string')
                alarmStr += " (" + alarmReason + ")";
            // alarm level 2 => audio alarm, since manual intervention is needed
            // like venting. 
            this.bmvAlarmMonitor.setActive(alarm.raise.bind(alarm, this.id + 7, 0, alarmStr));
        }
        else {
            this.bmvAlarmMonitor.clearActive();
            alarm.clear(this.id + 7, true);
        }
    };
}


// \class protection / alarm if PVvoltage above 32 and charging current <= 0
// \detail occassionally the Tracer 4215 RN gets into a mode with a high PV
//         voltage but the battery is still discharge. This naturally must
//         result heat production from the discharging battery and the
//         vapourization of the incoming PV energy. Necessary reaction:
//         removeLoad because any load discharges the battery and it is not
//         known when and if the Tracer recovers from this. Typically
//         disconnect Tracer completely (remove/open all fuses) to resolve.
//         Hence: play alarm as loud as possible
class ChargerOverheatProtection {
    constructor(name, config, actuator) {
        this.id     = config.id;
        this.name   = name;
        this.config = config;
        this.actuator  = actuator;
        this.chargingBlockedMonitor = new Monitor(this.config.durationActive);
        this.negativePVCurrentMonitor = new Monitor(this.config.durationActive);
    }

    alarmAndRemoveLoad(alarmStr, incr) {
        // For now just raise the alarm. The MPPT charger needs to be reset.
        // There is no obvious command to reset the MPPT charger and for now
        // it has to be done manually by pulling all fuses to fully disconnect
        // the charger.
        // Remove load until alarm is solved by disconnecting the MPPT charger.
        // This prevents discharge of batteries.
        if (this.config.alarmLevel >= 1) {
            alarmStr += " load OFF";
            if (! injectionTest())
                this.actuator.removeLoad();
        }
        alarm.raise(this.id + incr, this.config.alarmLevel, alarmStr);
    }

    setFlow(flow) {
        logger.trace("ChargerOverheatProtection::setFlow");
        if (! flow) return; // on null and undefined return
        let I = flow.getCurrent();
        let U = flow.getVoltage();

        if (injectionTest()) {
            if ('ChargerOverheatProtection' in testdata) {
                U = testdata.ChargerOverheatProtection.U;
                I = testdata.ChargerOverheatProtection.I;
                console.log("ChargerOverheatProtection - testing: U = " + U + ", I = " + I);
            }
            else return; // for better testing exclude protection classes w/o injection
        }
        if (! U) return; // there is no PV voltage of 0
        if (I === null || typeof I === 'undefined') return;
        let Istr = I.toFixed(2) + "A";
        let Ustr = U.toFixed(2) + "V";

        if ('minVoltage' in this.config && 'whenCurrentBelow' in this.config 
            && U >= this.config.minVoltage && I <= this.config.whenCurrentBelow) {
            let alarmStr = this.name + ": charging blocked (" + Ustr +
                ", " + Istr + ", " + this.chargingBlockedMonitor.getActiveTime() + "s)";
            this.chargingBlockedMonitor.setActive(this.alarmAndRemoveLoad.bind(
                this, alarmStr, 4));
        }
        else {
            this.chargingBlockedMonitor.clearActive();
            alarm.clear(this.id + 4, true);
        }
        // negative PV current ==> electricity is pumped into PV
        // This happens in the evening time for a few minutes.
        if (! this.chargingBlockedMonitor.isActive()
            || this.negativePVCurrentMonitor.isActive()) {
            if (I < 0) {
                let alarmStr = this.name + ": charger discharging (" + Ustr +
                    ", " + Istr + ", " + this.negativePVCurrentMonitor.getActiveTime() + "s)";
                this.negativePVCurrentMonitor.setActive(this.alarmAndRemoveLoad.bind(this, alarmStr, 5));
            }
            else {
                this.negativePVCurrentMonitor.clearActive();
                alarm.clear(this.id + 5, true);
            }
        }
    }
}


module.exports.BatteryProtection = BatteryProtection;
module.exports.FlowProtection = FlowProtection;
module.exports.ChargerOverheatProtection = ChargerOverheatProtection;
module.exports.DeviceProtection = DeviceProtection;
