<p align="center">
  <img src="static/bookie.svg" alt="Bookie Logo" width="200">
</p>
# Bookie - A small buisness accounting app

Bookie is a minimalistic app that helps you store and create invoices. Fully local and compliant with the german Law.

## To run and compile 

### Install dependendcies
```bun install```
### Run dev mode
```bun run tauri dev```
### Run build 
```bun run tauri build```


## Supported features
- Completely local management of invoices
- Creation of law compliant invoices 
- Upload of incoming invoices 
- Dashboard which calculates your profit / loss & revenue 
- Time Reporting 
- Backup creation & Upload of database for recreation of application state 
- (Optional) S3 Bucket support for automated Backup and invoice upload & resilience 


## For non technical users 
- You can download the executable programm from releases
- (Coming soon) A cloud managed version for a small fee to cover the cost is available
It contains the same features as with the s3 bucket. But you dont have to set up your bucket yourself and we do all the work for you

[![GitHub stars](https://img.shields.io/github/stars/Ranelkin/bookie.svg?style=social&label=Star)](https://github.com/Ranelkin/bookie)

## Contributing 
- Please refer to CONTRIBUTING.md
- It would be amazing if you can help add support for other languages & their juristictions