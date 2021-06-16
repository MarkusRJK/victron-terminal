var log4js = require('log4js');

const logger = log4js.getLogger();

const minutesToMS = 60 * 1000;

// singleton class Alarm
class Alarm {
    constructor(historyLength, silenceInMinutes) {
        logger.trace('Alarm::constructor');
        if(! Alarm.instance){
            this.alarmHistory = [];
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

    // try to reduce to historyLength, yet keep all active alarms
    reduce() {
        if (this.alarmHistory.length <= this.historyLength) return;
        let filteredHistory = this.alarmHistory.filter((a) => a.isActive);
        this.alarmHistory = filteredHistory;
    }

    persistJSON() {
        return this.alarmHistory;
    }

    formatAlarm(a, separator) {
        let levelTxt;
        switch (a.level) {
        case 0: levelTxt = 'low'; break;
        case 1: levelTxt = 'medium'; break;
        case 2: levelTxt = 'high'; break;
        }
        // add String(a.time)      + separator + with good format
        return levelTxt + separator + a.failure + separator + a.action + '\n';
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
        if (this.alarmHistory.length === 0) return "No alarms";
        return output;
    }

    recentAlarm() {
        if (this.alarmHistory.length) return this.alarmHistory[0];
        else return null;
    }
    
    raise(id, l, failureText, actionText, eventTime) {
	if (! eventTime) eventTime = new Date();

        if (this.alarmHistory.filter(a => a.isActive && !a.isAckn).some(a => a.id === id))
            return; // already entered 
        let alarm = { time     : eventTime,
                      id       : id,
                      level    : l,
                      failure  : failureText,
                      action   : actionText,
                      isAckn   : false,
                      isActive : true,
                      isAudible: (l >= 1)
                    };
        this.alarmHistory.unshift(alarm);
        this.reduce();
        if (l === 2) logger.error("ALARM: " + JSON.stringify(alarm));
        else logger.warn("ALARM: " + JSON.stringify(alarm));
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
        const i = this.alarmHistory.findIndex((element) => element.id === id);
        if (i < 0 || i >= this.alarmHistory.length) return;
        if (force || this.alarmHistory[i].isAckn) {
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




// consumes the flow and checks for violation of safe conditions
class FlowProtection {
    // \param config file in JSON containing Alarms and Protection settings
    // \param actor is the victron control
    constructor(id, name, config, alarm, actor) {
        this.id     = id * 100;
        this.name   = name
        this.config = config;
        this.alarm  = alarm;
        this.actor  = actor;
    }

    setFlow(flow) {
        if (! flow) return; // on null and undefined return
        let I = flow.getCurrent();
        let U = flow.getVoltage();
        if (U === 0) return; // there is no battery voltage of 0
        let Istr = String(I) + "A";
        let Ustr = String(U) + "V";

        if (I <= this.config.absMinCurrent) {
            this.alarm.raise(this.id + 0, this.config.alarmLevel,
                             this.name + ": too much load " + Istr,
                             "Removing load from battery");
            // FIXME: to be integer put action text only if alarmLevel === 2
            if (this.config.alarmLevel === 2) this.actor.setRelay(0);
        }
        else {
            this.alarm.clear(this.id + 0, true); // FIXME: Hysteresis needed
        }

        if (I >= this.config.absMaxCurrent) {
            this.alarm.raise(this.id + 1, this.config.alarmLevel,
                             this.name + ": high charge current " + Istr,
                             "Switching load on battery");
            if (this.config.alarmLevel === 2) this.actor.setRelay(1);
        }
        else this.alarm.clear(this.id + 1, true);

        if (U <= this.config.minVoltage && I <= this.config.whenCurrentBelow) {
            this.alarm.raise(this.id + 2, this.config.alarmLevel,
                             this.name + ": battery capacity too low; voltage drop to " + Ustr + " for small current " + Istr,
                             "Removing load from battery");
            if (this.config.alarmLevel === 2) this.actor.setRelay(0);
        }
        else this.alarm.clear(this.id + 2, true);

        if (U >= this.config.maxVoltage && I >= this.config.whenCurrentAbove) {
            this.alarm.raise(this.id + 3, this.config.alarmLevel,
                             this.name + ": battery capacity too high; voltage " + Ustr + " and charging at " + Istr,
                             "Switching load on battery");
            if (this.config.alarmLevel === 2) this.actor.setRelay(1);
        }
        else this.alarm.clear(this.id + 3, true);
    }
}



// Protection / Alarm if BMV alarm
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
                             this.name + ": charger discharging; voltage " + Ustr + "V and charging at " + Istr + "A",
                             "Switching load on battery");
            // For now just raise the alarm. The MPPT charger needs to be reset.
            // There is no obvious command to reset the MPPT charger and for now
            // it has to be done manually by pulling all fuses to fully disconnect
            // the charger.
            // It is unclear whether switching on load would help.
            //if (this.config.alarmLevel === 2) this.actor.setRelay(1);
        }
        else this.alarm.clear(this.id + 4, true);
    }
}


module.exports.Alarm = Alarm;
module.exports.FlowProtection = FlowProtection;
module.exports.ChargerOverheatProtection = ChargerOverheatProtection;
