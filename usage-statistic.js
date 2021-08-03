var fs = require('fs');
const logger = require('log4js').getLogger();


const file = __dirname + '/usage.json';

class HourlyUsageBuckets {
    // \param daysMemory is the number of days to keep in memory
    constructor(daysMemory) {
        this.daysMemory = daysMemory;
        // array for "daysMemory" days, each day has 24 hours (buckets)
        this.bucketsOfDay = null;

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
        logger.trace('HourlyUsageBuckets::logUsage(' + hour + ' , ' + value + ')');
        hour = hour % 24;
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
        logger.debug('HourlyUsageBuckets::writeData');
        // FIXME: add timestamp to data object?
        let data = {
            today: this.today,
            buckets: this.bucketsOfDay
        }
        let jData = JSON.stringify(data);
        logger.info('Writing usage data to file ' + file);
        let usageFile = fs.createWriteStream(file, {flags: 'w'});
        usageFile.write(jData);
        console.log(jData);
    }
    
    readData() {
        logger.trace('HourlyUsageBuckets::readData');
        let isFileRead = false;
        
        try {
            let data = fs.readFileSync(file, 'utf8');
            let usageObj = JSON.parse(data);

            this.today = (usageObj.today ? usageObj.today : 0);

            if (usageObj.buckets && typeof usageObj.buckets === 'object'
                && usageObj.buckets.length === 24) {
                logger.info('HourlyUsageBuckets::readData - read usage object from file' + file);
                this.bucketsOfDay = usageObj.buckets.map((b, index) => {
                    if (!b) return 0;
                    else return b;
                });
                isFileRead = true;
            }
        }
        catch (err) {
            logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
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
