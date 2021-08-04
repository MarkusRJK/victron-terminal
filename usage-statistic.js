var fs = require('fs');
const logger = require('log4js').getLogger();



class HourlyUsageBuckets {
    // \param daysMemory is the number of days to keep in memory
    constructor(daysMemory, file) {
        this.daysMemory = daysMemory;
        // array for "daysMemory" days, each day has 24 hours (buckets)
        this.bucketsOfDay = null;
        this.file = file;
        
        this.readData();
    }

    terminate() {
        this.writeData();
    }

    setNextDay() {
        logger.trace('HourlyUsageBuckets::setNextDay');
        this.today = (this.today + 1) % this.daysMemory;
    }

    logUsage(hour, value) {
        hour = hour % 24;
        logger.trace('HourlyUsageBuckets::logUsage(' + hour + ' , ' + value + ')');
        if (! this.bucketsOfDay) throw 'HourlyUsageBuckets::logUsage - no buckets';
        this.bucketsOfDay[hour][this.today] = value;
    }

    // \param hour is [0; 23]
    getAvgUsage(hour) {
        let sum = this.bucketsOfDay[hour].reduce(function(acc, curVal) {
            acc += curVal;
            return acc;
        }, 0);
        return sum / this.daysMemory;
    }

    writeData() {
        logger.trace('HourlyUsageBuckets::writeData');
        let data = {
            today: this.today,
            buckets: this.bucketsOfDay
        }
        let jData = JSON.stringify(data);
        logger.info('HourlyUsageBuckets::writeData - Writing usage data to file ' + this.file);
        let usageFile = fs.createWriteStream(this.file, {flags: 'w'});
        usageFile.write(jData);
    }
    
    readData() {
        logger.trace('HourlyUsageBuckets::readData');
        let isFileRead = false;
        
        try {
            let data = fs.readFileSync(this.file, 'utf8');
            let usageObj = JSON.parse(data);

            this.today = (usageObj.today ? usageObj.today : 0);

            if (usageObj.buckets && typeof usageObj.buckets === 'object'
                && usageObj.buckets.length === 24) {
                logger.info('HourlyUsageBuckets::readData - read usage object from file' + this.file);
                this.bucketsOfDay = usageObj.buckets.map((b, index) => {
                    if (!b) return 0;
                    else return b;
                });
                isFileRead = true;
            }
        }
        catch (err) {
            logger.error(`cannot read: ${this.file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        }
        if (! isFileRead) {
            logger.info('HourlyUsageBuckets::readData - creating empty buckets');
            this.today = 0;
            this.bucketsOfDay = Array.from(
                Array(24),
                () => Array.from(Array(this.daysMemory), () => 0));
        }
    }
}


module.exports.HourlyUsageBuckets = HourlyUsageBuckets;
