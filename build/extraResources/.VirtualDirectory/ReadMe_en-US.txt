# Virtual Directory Instructions

## Overview

`.VirtualDirectory` is an automatically generated virtual directory by this application, used to display an intelligently organized file structure. It maintains a one-to-one correspondence with the original files, but uses smart naming conventions.

## Purpose

The main purpose of this virtual directory is to enable multi-dimensional file management. When you are satisfied with the final result, you can copy the files within this directory to any location for the next virtual directory generation.

## Features

The files in the virtual directory can be simply understood as file references or aliases, with the following characteristics:

1. Does not occupy additional physical disk space
2. Shares the same data blocks with the original files
3. Modifications to files will be synchronized with the original files
4. Deleting files will not affect the original files
5. If the original file is deleted, this file effectively replaces the original file and should also be deleted