# Frugal IoT client

This is a javascript based client for the Frugal IoT project, in particular it has the 
following features

* Can connect to MQTT.
* Understands the discovery messages of Frugal IoT so can determine what sensors are available
* Can display results from sensors in Bar graphs, toggles, with other UX coming soon
* Can control nodes including both direct control
  e.g. toggling a relay - and configuting various parameters.
* Can show graph results for multiple readings

There is much still to do - see https://github.com/mitra42/frugal-iot-client. 
This repo was spun out of the main repo https://github.com/mitra42/frugal-iot 
which is still the best place to post complex issues involving client / server and node. 

## Test and demonstration

Connect to https://frugaliot.naturalinnovation  it will server up the current UI.

## Installation for development

Note this process will probably change to make configuration changes for development easier.

This should work on Linux or a Mac - (instructions on windows welcome as a PR)
Clone this repo, 
```
git clone https://github.com/mitra42/frugal-iot-client.git
cd frugal-iot-client; npm install
cd ..
```
Clone and run the server
```
git clone https://github.com/mitra42/frugal-iot-server.git
cd frugal-iot-server; npm install
```
Edit `frugal-iot-server.js` and uncomment the line hear the top
that sets `htmldir` to the `../frugal-iot-client`
```
node frugal-iot-server.js
```
Point your browser at `https://localhost:8080`

You should see a series of dialogues allowing you to select a project.
Choosing `dev` and `lotus` will often get one of the test nodes I'm running at home.



