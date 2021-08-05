var fs = require('fs');
const logger = require('log4js').getLogger(); // getLogger('silent');

const file = __dirname + '/alarms.json';

const minutesToMS = 60 * 1000;

const cRed    = "\x1b[5m\x1b[1m\x1b[31m";
const cGreen  = "\x1b[1m\x1b[32m";
const cYellow = "\x1b[33m";
const cReset  = "\x1b[0m";


// singleton class AlarmsImpl
// TODO: implement new policy:
// low priority alarm:    alarm notification of possibly harmful state (no action)
// medium priority alarm: alarm notification with action
// high priority alarm:   alarm notification with possible action which
//                        requires use interference
class AlarmsImpl {
    constructor(historyLength, silenceInMinutes) {
        logger.trace('AlarmsImpl::constructor');
        if(! AlarmsImpl.instance){
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
            AlarmsImpl.instance = this;
        }
        return AlarmsImpl.instance;
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
        logger.trace('AlarmsImpl::raise(' + id + ', ' + alevel + ')');
        let now = Date.now();
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
        logger.trace('AlarmsImpl::clear(' + id + ')');
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


// \brief Extends Alarms by serialization
class SerializedAlarms extends AlarmsImpl {
    constructor(historyLength, silenceInMinutes) {
        super(historyLength, silenceInMinutes);
    }
    
    terminate() {
        this.writeAlarms();
    }

    writeAlarms() {
        logger.trace('SerializedAlarms::writeAlarms');
        let jData = JSON.stringify(this.alarmHistory);
        logger.info('Writing alarm file ' + file);
        let alarmFile = fs.createWriteStream(file, {flags: 'w'});
        alarmFile.write(jData);
    }

    readAlarms() {
        logger.trace('SerializedAlarms::readAlarms');

        try {
            let data = fs.readFileSync(file, 'utf8');
            this.alarmHistory = JSON.parse(data);
            logger.info('Alarms retrieved from ' + file);
        }
        catch (err) {
            logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        }
    }
}


class Alarms {
    constructor() {
        if(! Alarms.instance){
            this.alarms = null;
            Alarms.instance = this;
        }
        return Alarms.instance;
    }

    terminate() {
        if (this.alarms) this.alarms.terminate();
    }

    raise(id, alevel, failureText, actionText, eventTime) {
        if (this.alarms) this.alarms.raise(id, alevel, failureText, actionText, eventTime);
    }

    clear(id, force) {
        if (this.alarms) this.alarms.clear(id, force);
    }

    persistPlain(separator) {
        if (this.alarms) return this.alarms.persistPlain(separator);
        return "";
    }

    // \pre this.appConfig.Alarms exists
    parseConfig(config) {
        logger.trace('Alarms::parseConfig');
        let a = null;
        if ('Alarms' in config) {
            logger.info("Alarms::parseConfig - reading Alarms");
            a = config['Alarms'];
        } else logger.warn("Alarms::parseConfig - no Alarms section defined - using defaults");
        let h = 20; // default
        if (a && 'history' in a) h = a['history'];
        else logger.warn(`Alarms::parseConfig - no Alarms history defined - using default ${h}`);
        let sInMin = 5; // default
        if (a && 'silenceInMin' in a) sInMin = a['silenceInMin'];
        else logger.warn(`Alarms::parseConfig - no Alarms silenceInMin defined - using default ${sInMin}`);

        // Protection and alarms - must be created before registerListener
        this.alarms = new SerializedAlarms(h, sInMin);
    }
}

module.exports.Alarms = Alarms;
