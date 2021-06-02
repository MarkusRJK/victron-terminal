# victron-terminal

Terminal application for victron server for monitoring, setting and controlling values of the
Victron BMV.


### Description

Displays and updates all BMV values in the terminal as they arrive from the BMV. A task bar
allows to reset alarms, reboot BMV, download or upload the configuration (battery capacity,
tail current etc.), ping the BMV, switch the relay, set the SOC, or display the version and
switch to the display of history values.


### Installation

```
git clone https://github.com/MarkusRJK/victron-terminal.git
cd victron-terminal
npm install
```

### Usage

Run 

```
$ npm start 
```

### Restrictions

The BMV is terribly slow. It can take minutes until a command is executed
or until the confirmation returns.
