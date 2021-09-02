var fs = require('fs');
const ECMeter = require( './meter' ).EnergyAndChargeMeter;
var cron = require('node-cron');
const logger = require('log4js').getLogger();


const f1 = __dirname + '/usage.json';
const f2 = __dirname + '/baseUsage.json';


class BucketsWithHistory {
    // \param memory is the number of days to keep in memory
    constructor(noOfBuckets, memory) {
        this.memory = memory; // memory/history per bucket
        this.noOfBuckets = noOfBuckets;
        // array for "daysMemory" days, each day has 24 hours (buckets)
        this.buckets = null;
    }

    set(x, y, value) {
        if (! this.buckets) throw 'BucketsWithHistory::set - no buckets';
        x = x % this.noOfBuckets;
        y = y % this.memory;
        logger.trace('BucketsWithHistory::set(' + x + ', ' + y + ', ' + value + ')');
        this.buckets[x][y] = value;
    }  

    // \return first element in buckets[x] containing value
    find(x, value) {
        return this.buckets[x].findIndex((element) => element === value);
    }

    // \param index in [0; this.noOfBuckets]
    getAvgValue(index) {
        index = index % this.noOfBuckets;
        let sum = this.buckets[index].reduce(function(acc, curVal) {
            acc += curVal;
            return acc;
        }, 0);
        return sum / this.memory;
    }

    initBuckets(v) {
        logger.trace('BucketsWithHistory::initBuckets - creating empty buckets');
        this.buckets = Array.from(
            Array(this.noOfBuckets),
            () => Array.from(Array(this.memory), () => v));
    }
}


// \brief Extend by serialization functionality
class SerializedHourlyUsageBuckets extends BucketsWithHistory {
    // \param daysMemory is the number of days to keep in memory
    constructor(daysMemory, file) {
        // array for 24 hours (buckets) with "daysMemory" days
        super(24, daysMemory);

        this.file = file;
        this.hour = 0;
        this.currentMem = 0;
        this.readData();

        const hour = new Date().getHours();
        this.setNextMemory(hour);
    }

    terminate() {
        this.writeData();
    }

    setNextMemory(hour) {
        logger.debug('SerializedHourlyUsageBuckets::setNextMemory(' + hour + ')');
        logger.debug('changing from hour ' + this.hour + ' to ' + hour);
        this.hour = hour;
        logger.debug('changing from currMem ' + this.currentMem);
        this.currentMem = this.find(hour, 0);
        logger.debug('                   to ' + this.currentMem);
        this.set(hour, this.currentMem + 1, 0); // mark next position for entry
        logger.debug('mark hour ' + hour + ' currMem ' + this.currentMem + ' with 0');
    }

    logValue(value) {
        this.set(this.hour, this.currentMem, value);
    }

    writeData() {
        logger.trace('SerializedHourlyUsageBuckets::writeData');
        let jData = JSON.stringify(this.buckets);
        logger.info('SerializedHourlyUsageBuckets::writeData - Writing usage data to file ' + this.file);
        let usageFile = fs.createWriteStream(this.file, {flags: 'w'});
        usageFile.write(jData);
    }
    
    readData() {
        logger.trace('SerializedHourlyUsageBuckets::readData');
        let isFileRead = false;
        
        try {
            let data = fs.readFileSync(this.file, 'utf8');
            let usageObj = JSON.parse(data);

            if (usageObj.length === 24) {
                logger.info('SerializedHourlyUsageBuckets::readData - read usage object from file' + this.file);
                this.buckets = usageObj.map((b, index) => {
                    let returnArray = new Array(this.memory);
                    for (let i = 0; i < this.memory; ++i) {
                        // return 0 if b is undefined or null or else
                        if (i < b.length)
                            returnArray[i] = (b[i] && typeof b[i] === 'number' ? b[i] : 0);
                        else returnArray[i] = 0;
                    }
                    return returnArray;
                });
                isFileRead = true;
            }
            else logger.error('SerializedHourlyUsageBuckets::readData - usage object invalid or missing (' + this.file + ')');
        }
        catch (err) {
            logger.error(`cannot read: ${this.file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        }
        if (! isFileRead) {
            this.initBuckets(0);
        }
    }
}


// \brief Extend by configuration and cron job for writing the data
class HourlyUsageBuckets {
    constructor(noOfBuckets, memory) {
        this.usage          = null;
        this.baseUsage      = null;
        this.usageMeterId   = 0;
        //this.writeUsageTask = null;
        this.addWriteTask   = null;
    }

    terminate() {
        //if (this.writeUsageTask) this.writeUsageTask.stop();
        clearInterval(this.addWriteTask);
        // FIXME: destroy() errors although api says that tasks have destroy()
        //this.writeTask.destroy(); 
        if (this.usage) this.usage.terminate();
        if (this.baseUsage) this.baseUsage.terminate();
    }

    isNextHour(hour) {
        let value = (hour > this.hour || (hour === 0 && this.hour === 23));
        logger.debug('isNextHour: hour = ' + hour + ' this.hour = ' + this.hour);
        if (value) logger.debug('isNextHour: true');
        return value;
    }

    logUsage(relayState, timeStamp) {
        try {
            // FIXME: some initial huge values
            // FIXME: no progressing into next array field
            logger.trace('HourlyUsageBuckets::logUsage');
            const hour = new Date(timeStamp).getHours();
            // FIXME: only log the EUsed value if the relay is on and only for the time
            //        it is on. If relay not on for the full hour, scale usage to full hour
            //        and mix with value in the cell by weights (length of time)
            //        ==> leads to negative usage values
            if (this.usage && relayState === 'ON') {
                // FIXME: is this correcter now?
                // FIXME: EUsed sometimes < 0 why?
                this.usage.logValue(ECMeter.getEUsed(this.usageMeterId));
                    //- ECMeter.getELowVoltUse(this.usageMeterId));
            }
            // somehow count time while relay is on for scaling
            if (this.baseUsage) {
                this.baseUsage.logValue(ECMeter.getELowVoltUse(this.usageMeterId));
            }
            if (this.isNextHour(hour)) {
                this.usage.setNextMemory(hour);
                this.baseUsage.setNextMemory(hour);
                this.usageMeterId = ECMeter.setStart(this.usageMeterId);
            }
        }
        catch(err) {
            logger.error('HourlyUsageBuckets::logUsage failed: ' + err);
        }
    }

    parseConfig(config) {
        let u = null;
        if ('Usage' in config) {
            logger.info("HourlyUsageBuckets::parseConfig - parsing Usage");
            u = config['Usage'];
        } else logger.warn("HourlyUsageBuckets::parseConfig - no Usage section defined - using defaults");
        let h = 14; // days - default
        if (u && 'history' in u) h = u['history'];
        else logger.warn(`HourlyUsageBuckets::parseConfig - no Usage history defined - using default ${h}`);
        
        this.usage     = new SerializedHourlyUsageBuckets(h, f1);
        this.baseUsage = new SerializedHourlyUsageBuckets(h, f2);
        this.usageMeterId = ECMeter.setStart();

        // schedule a write every full hour, reset the meter and change to next day at 0:00
        //                                   ┌────────────── second (optional)
        //                                   │ ┌──────────── minute
        //                                   │ │ ┌────────── hour
        //                                   │ │ │ ┌──────── day of month
        //                                   │ │ │ │ ┌────── month
        //                                   │ │ │ │ │ ┌──── day of week
        //                                   │ │ │ │ │ │
        //                                   │ │ │ │ │ │
        // this.writeUsageTask = cron.schedule('0 0 * * * *', (() => {
        //     logger.debug('cron: write usage, reset meter for next hour');
        //     let uObj = this.usage;
        //     let buObj = this.baseUsage;
        //     logger.debug('cron: current hour ' + thisHour);
        //     if (!uObj || ! buObj) {
        //         logger.warn('cron: No usage, baseUsage exists');
        //         return;
        //     }
        //     uObj.writeData();
        //     buObj.writeData();
        // }).bind(this));
        // additional writes so that no data is lost if application is restarted
        this.addWriteTask = setInterval((() => {
            logger.debug('addWriteTask');
            this.usage.writeData();
            this.baseUsage.writeData();
        }).bind(this), 660000); // = 11 minutes = 11 * 60 * 1000
    }
}



module.exports.HourlyUsageBuckets = HourlyUsageBuckets;
