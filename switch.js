const Alarms = require('./alarms').Alarms;
const logger = require('log4js').getLogger(); // getLogger('silent');


class MonitoredSwitch {

    constructor(actuator, monitorTimeInS) {
        if(! MonitoredSwitch.instance){
            logger.debug("MonitoredSwitch::constructor");
            this.actuator = actuator;
            this.sunsetTimer = null;
            this.removeLoadTime = null;
            this.checkTimer = null;
            this.monitorTimeInMs = ( monitorTimeInS ? monitorTimeInS : 5 * 60 ) * 1000; // default 5 min
            MonitoredSwitch.instance = this;
        }
        return MonitoredSwitch.instance;
    }

    // \param absoluteTime is sunsetTime minus the shortest time charge happened in the past days
    //        set this to null or leave undefined to disable functionality
    setRemoveLoadTime(absoluteTime) {
        this.removeLoadTime = absoluteTime;
        const timeTillRemoveLoad = this.removeLoadTime - Date.now();
        this.sunsetTimer = setTimeout(this.removeLoad.bind(this), timeTillRemoveLoad);
    }

    // private - don't use
    setLoad(v) {
        logger.debug("MonitoredSwitch::setLoad " + v); // FIXME: revert to trace
        this.actuator.setRelay(v);
        if (this.checkTimer) clearTimeout(this.checkTimer);
        // after 5 minutes check
        this.checkTimer = setTimeout(this.checkLoad.bind(this), this.monitorTimeInMs,
                                     (v === 0 ? 'OFF' : 'ON')); 
    }

    removeLoad() {
        logger.debug("MonitoredSwitch::removeLoad"); // FIXME: revert to trace
        clearTimeout(this.sunsetTimer);
        this.sunsetTimer = null;
        this.setLoad(0);
    }

    switchLoad() {
        logger.debug("MonitoredSwitch::switchLoad"); // FIXME: revert to trace

        if (this.removeLoadTime) {
            const timeTillRemoveLoad = this.removeLoadTime - Date.now();
            if (timeTillRemoveLoad > 15 * 60 * 1000) { // min. 15 min ON
                this.sunsetTimer = setTimeout(this.removeLoad.bind(this), timeTillRemoveLoad);
                this.setLoad(1);
            }
        }
        else {
            this.setLoad(1);
        }
    }

    // \param state is either 'ON' or 'OFF'
    checkLoad(state) {
        logger.debug("MonitoredSwitch::checkLoad");
        this.checkTimer = null;
        if (this.actuator.getRelay() !== state)
            // TODO: raise HP alarm with alarms.js
            logger.fatal("MonitoredSwitch failed after " + this.monitorTimeInMs * 0.001
                         + "sec: Load is "
                         + this.actuator.getRelay() + " while it should be " + state);
    }

    isLoadOn() {
        return this.actuator.getRelay() === 'ON';
    }
}


// \brief  Switcher queues switch on/off commands
// \detail If the last switch activity was long enough in the past
//         then switch, otherwise set a timer for the next switch
//         activity so that it is executed only after a minimum
//         period of time (hysteresis by time)
class Switcher {
    // \param sw the bmv with a switch command setRelay(mode, priority, force)
    // \param minDurationInMin minimal duration between two switch commands in
    //        minutes
    constructor(sw, minDurationInMin) {
	this.sw = sw;
	this.minDurationInMin = minDurationInMin * 60000; // min -> ms
	this.lastTime = undefined;
	this.lastMode = undefined;
	this.switchDeferTimer = null;
    }

    setSwitch(mode, isForce) {
	let currentTime = new Date();

	if (this.switchDeferTimer)
	    // timer is already running => run last switch action
	    this.lastMode = mode;
	else if (this.lastTime === undefined || isForce
	    || currentTime - this.lastTime > this.minDurationInMS)
	{
	    this.lastTime = currentTime;
	    this.lastMode = mode;
	    doSwitchNow(isForce); // switch immediately
	}

	if (! this.switchDeferTimer) // timer not yet running => start defered execution
	    this.switchDeferTimer
		= setTimeout(function()
                             {
                                 this.doSwitchNow();
                             }.bind(this), this.minDurationInMS);
    }

    doSwitchNow(isForce) {
	if (isForce)
	    // switch with priority
	    this.sw.setRelay(this.lastMode, 1, isForce);
	else this.sw.setRelay(this.lastMode, 0);
	clearTimeout(this.switchDeferTimer);
	this.switchDeferTimer = null;
    }
}


module.exports.MonitoredSwitch = MonitoredSwitch;

