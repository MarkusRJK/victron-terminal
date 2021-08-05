var fs = require('fs');
const ECMeter = require( './meter' ).EnergyAndChargeMeter;
var cron = require('node-cron');
const logger = require('log4js').getLogger();


const f1 = __dirname + '/usage.json';
const f2 = __dirname + '/baseUsage.json';


class BucketsWithHistory {
    // \param memory is the number of days to keep in memory
    constructor(noOfBuckets, memory) {
        this.memory = memory;
        this.noOfBuckets = noOfBuckets;
        // array for "daysMemory" days, each day has 24 hours (buckets)
        this.buckets = null;
        this.currentMem = 0;
    }

    setNextMemory() {
        logger.trace('BucketsWithHistory::setNextMemory');
        this.currentMem = (this.currentMem + 1) % this.memory;
    }

    logValue(index, value) {
        index = index % this.noOfBuckets;
        logger.trace('BucketsWithHistory::logValue(' + index + ' , ' + value + ')');
        if (! this.buckets) throw 'BucketsWithHistory::logValue - no buckets';
        this.buckets[index][this.currentMem] = value;
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

    initBuckets() {
        logger.trace('BucketsWithHistory::initBuckets - creating empty buckets');
        this.currentMem = 0;
        this.buckets = Array.from(
            Array(this.noOfBuckets),
            () => Array.from(Array(this.memory), () => 0));
    }
}


// \brief Extend by serialization functionality
class SerializedHourlyUsageBuckets extends BucketsWithHistory {
    // \param daysMemory is the number of days to keep in memory
    constructor(daysMemory, file) {
        // array for "daysMemory" days, each day has 24 hours (buckets)
        super(24, daysMemory);

        this.file = file;
        this.readData();
    }

    terminate() {
        this.writeData();
    }

    writeData() {
        logger.trace('SerializedHourlyUsageBuckets::writeData');
        let data = {
            today: this.currentMem,
            buckets: this.buckets
        }
        let jData = JSON.stringify(data);
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

            this.currentMem = (usageObj.today ? usageObj.today : 0);

            if (usageObj.buckets && typeof usageObj.buckets === 'object'
                && usageObj.buckets.length === 24) {
                logger.info('SerializedHourlyUsageBuckets::readData - read usage object from file' + this.file);
                this.buckets = usageObj.buckets.map((b, index) => {
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
            this.initBuckets();
        }
    }
}


// \brief Extend by configuration and cron job for writing the data
class HourlyUsageBuckets {
    constructor(noOfBuckets, memory) {
        this.usage          = null;
        this.baseUsage      = null;
        this.usageMeterId   = 0;
        this.writeUsageTask = null;
    }

    terminate() {
        if (this.writeUsageTask) this.writeUsageTask.stop();
        // FIXME: destroy() errors although api says that tasks have destroy()
        //this.writeTask.destroy(); 
        if (this.usage) this.usage.terminate();
        if (this.baseUsage) this.baseUsage.terminate();
    }

    logUsage(timeStamp) {
        logger.trace('HourlyUsageBuckets::logUsage');
        const hour = new Date(timeStamp).getHours();
        // FIXME: ELowVoltUse > EUsed when relay is OFF although  - how should it actually be? Equal?
        if (this.usage)
            this.usage.logValue(hour, ECMeter.getEUsed(this.usageMeterId));
        if (this.baseUsage)
            this.baseUsage.logValue(hour, ECMeter.getELowVoltUse(this.usageMeterId));
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

        // schedule a write every full hour
        //                                   ┌────────────── second (optional)
        //                                   │ ┌──────────── minute
        //                                   │ │ ┌────────── hour
        //                                   │ │ │ ┌──────── day of month
        //                                   │ │ │ │ ┌────── month
        //                                   │ │ │ │ │ ┌──── day of week
        //                                   │ │ │ │ │ │
        //                                   │ │ │ │ │ │
        this.writeUsageTask = cron.schedule('0 0 * * * *', (() => {
            logger.debug('cron: write usage, reset meter for next hour');
            let uObj = this.usage;
            let buObj = this.baseUsage;
            let thisHour = (new Date()).getHours();
            logger.debug('cron: current hour ' + thisHour);
            if (!uObj || ! buObj) {
                logger.warn('cron: No usage, baseUsage exists');
                return;
            }
            if (thisHour === 0) {
                logger.info('cron: set next day');
                uObj.setNextMemory();
                buObj.setNextMemory();
            };
            uObj.writeData();
            buObj.writeData();
            ECMeter.setStart(this.usageMeterId);
        }).bind(this));
    }


}



module.exports.HourlyUsageBuckets = HourlyUsageBuckets;
